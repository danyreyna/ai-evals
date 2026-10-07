import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  resetPayments();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

async function expectApiError(
  call: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

const card = { amount: 1000, currency: "usd", source: "tok_visa" };

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(card);

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_.+/),
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...card, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("creates distinct ids for distinct payments", async () => {
    const a = await client.createPayment(card);
    const b = await client.createPayment(card);

    expect(a.id).not.toBe(b.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_nope" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero amount", { ...card, amount: 0 }],
    ["negative amount", { ...card, amount: -5 }],
    ["fractional amount", { ...card, amount: 10.5 }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects a missing field with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as typeof card;

    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment(card),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test("does not persist a payment that was declined", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(card);

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

  test("url-encodes ids so a slash cannot reach another route", async () => {
    await expectApiError(client.getPayment("a/b"), 404, "payment_not_found");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(card);

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(card);
    const b = await client.createPayment({ ...card, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    await client.createPayment(card);
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(card);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("an empty filter object behaves like no filter", async () => {
    const created = await client.createPayment(card);

    expect(await client.listPayments({})).toEqual([created]);
  });

  test("reflects status changes in the filtered results", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("accumulates partial refunds and becomes refunded at the full amount", async () => {
    const created = await client.createPayment(card);

    const first = await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });

    expect(first.status).toBe("partially_refunded");
    expect(second).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("refunds only the remaining balance when no amount follows a partial refund", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 300 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(card);
    const refunded = await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects a second refund with 409 already_refunded", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the payment with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount }), 422, "invalid_refund_amount");
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(card);
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(card);

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toEqual({ ...pending, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.getPayment(pending.id)).toEqual(canceled);
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(card);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling a payment twice with 409 not_cancelable", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.cancelPayment(pending.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.cancelPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    await expectApiError(badClient.cancelPayment(pending.id), 401, "unauthorized");
  });
});

describe("error fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/:id",
        () => new HttpResponse("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });

  test("uses unknown_error when the error body has no error object", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments", () =>
        HttpResponse.json({ detail: "nope" }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.listPayments(), 503, "unknown_error", "Service Unavailable");
  });
});

describe("request shape", () => {
  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://staging.example.com/v2/payments/:id", ({ params }) =>
        HttpResponse.json({
          id: params["id"],
          amount: 1,
          currency: "usd",
          source: "tok_visa",
          status: "succeeded",
          amountRefunded: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    const staging = new PaymentsClient({
      apiKey: "anything",
      baseUrl: "https://staging.example.com/v2",
    });

    const payment = await staging.getPayment("pay_x");

    expect(payment.id).toBe("pay_x");
  });
});
