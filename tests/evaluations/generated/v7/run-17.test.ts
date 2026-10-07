import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  resetPayments();
});
afterAll(() => {
  server.close();
});

async function expectApiError(
  call: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  // bun's `rejects` matchers are typed as sync but return a promise at runtime
  // oxlint-disable-next-line typescript/await-thenable
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  // oxlint-disable-next-line typescript/await-thenable
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

const visa = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_visa" });
const pending = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_pending" });

describe("createPayment", () => {
  test("returns a succeeded payment echoing the input", async () => {
    const before = Date.now();
    const payment = await client.createPayment({
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
    });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_.+/) as string,
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String) as string,
    });
    expect(Date.parse(payment.createdAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  test("returns a pending payment for the tok_pending source", async () => {
    const payment = await pending(700);

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(700);
    expect(payment.source).toBe("tok_pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const [a, b] = await Promise.all([visa(), visa()]);

    expect(a.id).not.toBe(b.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_nope" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(
      client.createPayment({ amount, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
    );
  });

  test("does not persist a payment that failed", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await visa(1234);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id so a slash does not change the route", async () => {
    await expectApiError(
      client.getPayment("a/refund"),
      404,
      "payment_not_found",
      "No payment with id a/refund",
    );
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await visa();
    const b = await pending();

    const list = await client.listPayments();

    expect(list).toHaveLength(2);
    expect(list).toEqual(expect.arrayContaining([a, b]) as Payment[]);
  });

  test("returns only payments with the requested status", async () => {
    const succeeded = await visa();
    const waiting = await pending();

    expect(await client.listPayments({ status: "pending" })).toEqual([waiting]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await visa();

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("reflects status changes made by other calls", async () => {
    const payment = await pending();
    const canceled = await client.cancelPayment(payment.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });
});

describe("refundPayment", () => {
  test("refunds the full amount when no amount is given", async () => {
    const payment = await visa(1000);

    const refunded = await client.refundPayment(payment.id);

    expect(refunded).toEqual({ ...payment, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when amount is less than the total", async () => {
    const payment = await visa(1000);

    const refunded = await client.refundPayment(payment.id, { amount: 400 });

    expect(refunded).toEqual({ ...payment, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remainder after a partial refund", async () => {
    const payment = await visa(1000);
    await client.refundPayment(payment.id, { amount: 400 });

    const refunded = await client.refundPayment(payment.id);

    expect(refunded).toEqual({ ...payment, status: "refunded", amountRefunded: 1000 });
  });

  test("allows a second partial refund and accumulates the total", async () => {
    const payment = await visa(1000);
    await client.refundPayment(payment.id, { amount: 300 });

    const refunded = await client.refundPayment(payment.id, { amount: 300 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(600);
  });

  test("persists the refund so getPayment sees it", async () => {
    const payment = await visa(1000);
    const refunded = await client.refundPayment(payment.id, { amount: 250 });

    expect(await client.getPayment(payment.id)).toEqual(refunded);
  });

  test("rejects an already refunded payment with 409 already_refunded", async () => {
    const payment = await visa();
    await client.refundPayment(payment.id);

    await expectApiError(
      client.refundPayment(payment.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects a pending payment with 409 not_refundable", async () => {
    const payment = await pending();

    await expectApiError(
      client.refundPayment(payment.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects a canceled payment with 409 not_refundable", async () => {
    const payment = await pending();
    await client.cancelPayment(payment.id);

    await expectApiError(
      client.refundPayment(payment.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the payment total with 422 invalid_refund_amount", async () => {
    const payment = await visa(1000);

    await expectApiError(
      client.refundPayment(payment.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const payment = await visa(1000);
    await client.refundPayment(payment.id, { amount: 800 });

    await expectApiError(
      client.refundPayment(payment.id, { amount: 300 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 200",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_label, amount) => {
    const payment = await visa(1000);

    await expectApiError(
      client.refundPayment(payment.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const payment = await pending();

    const canceled = await client.cancelPayment(payment.id);

    expect(canceled).toEqual({ ...payment, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const payment = await pending();
    const canceled = await client.cancelPayment(payment.id);

    expect(await client.getPayment(payment.id)).toEqual(canceled);
  });

  test("rejects a succeeded payment with 409 not_cancelable", async () => {
    const payment = await visa();

    await expectApiError(
      client.cancelPayment(payment.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects an already canceled payment with 409 not_cancelable", async () => {
    const payment = await pending();
    await client.cancelPayment(payment.id);

    await expectApiError(
      client.cancelPayment(payment.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects a refunded payment with 409 not_cancelable", async () => {
    const payment = await visa();
    await client.refundPayment(payment.id);

    await expectApiError(
      client.cancelPayment(payment.id),
      409,
      "not_cancelable",
      "A refunded payment cannot be canceled",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });
});

describe("authentication", () => {
  const bad = new PaymentsClient({ apiKey: "wrong_key" });
  const message = "Missing or invalid API key";

  test("createPayment rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(
      bad.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      message,
    );
  });

  test("getPayment rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(bad.getPayment("pay_any"), 401, "unauthorized", message);
  });

  test("listPayments rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(bad.listPayments(), 401, "unauthorized", message);
  });

  test("refundPayment rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(bad.refundPayment("pay_any"), 401, "unauthorized", message);
  });

  test("cancelPayment rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(bad.cancelPayment("pay_any"), 401, "unauthorized", message);
  });

  test("a rejected key does not create a payment", async () => {
    await expectApiError(
      bad.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("unexpected error responses", () => {
  test("falls back to unknown_error and statusText when the body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/:id",
        () =>
          new HttpResponse("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments", () =>
        HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.listPayments(), 503, "unknown_error", "Service Unavailable");
  });
});
