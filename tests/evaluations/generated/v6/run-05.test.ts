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
  // oxlint-disable-next-line typescript/await-thenable -- bun's `rejects` is typed as void but returns a promise
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  // oxlint-disable-next-line typescript/await-thenable -- see above
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card source", async () => {
    const before = Date.now();
    const payment = await client.createPayment({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
    });

    expect(payment.id).toMatch(/^pay_/);
    expect(payment).toEqual({
      id: payment.id,
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: payment.createdAt,
    });
    expect(new Date(payment.createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  test("returns a pending payment for the pending source", async () => {
    const payment = await client.createPayment({
      amount: 1000,
      currency: "eur",
      source: "tok_pending",
    });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(1000);
    expect(payment.currency).toBe("eur");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const a = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const b = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

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

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];

    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the stored payment by id", async () => {
    const created = await client.createPayment({
      amount: 4200,
      currency: "usd",
      source: "tok_visa",
    });

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("encodes special characters in the id", async () => {
    await expectApiError(
      client.getPayment("a/b c"),
      404,
      "payment_not_found",
      "No payment with id a/b c",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment({
      amount: 4200,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const b = await client.createPayment({ amount: 200, currency: "usd", source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).toSorted()).toEqual([a.id, b.id].toSorted());
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment({
      amount: 100,
      currency: "usd",
      source: "tok_visa",
    });
    const pending = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes made by refund and cancel", async () => {
    const toRefund = await client.createPayment({
      amount: 100,
      currency: "usd",
      source: "tok_visa",
    });
    const toCancel = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });
    await client.refundPayment(toRefund.id);
    await client.cancelPayment(toCancel.id);

    const refunded = await client.listPayments({ status: "refunded" });
    const canceled = await client.listPayments({ status: "canceled" });

    expect(refunded.map((p) => p.id)).toEqual([toRefund.id]);
    expect(canceled.map((p) => p.id)).toEqual([toCancel.id]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 3000 });
  });

  test("partially refunds when an amount below the total is given", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id, { amount: 1000 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 1000 });
  });

  test("moves to refunded once partial refunds add up to the total", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 1000 });

    const refunded = await client.refundPayment(created.id, { amount: 2000 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(3000);
  });

  test("refunds the remaining balance of a partially refunded payment by default", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 1200 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(3000);
  });

  test("persists the refund so getPayment returns the updated payment", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });
    const refunded = await client.refundPayment(created.id, { amount: 500 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_pending",
    });

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the total with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(
      client.refundPayment(created.id, { amount: 3001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 3000",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 2500 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 501 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 500",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -100],
    ["fractional", 10.5],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("does not change the payment when the refund is rejected", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });
    await expectApiError(
      client.refundPayment(created.id, { amount: 9999 }),
      422,
      "invalid_refund_amount",
    );

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment({
      amount: 3000,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({
      amount: 1500,
      currency: "usd",
      source: "tok_pending",
    });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment returns the updated payment", async () => {
    const created = await client.createPayment({
      amount: 1500,
      currency: "usd",
      source: "tok_pending",
    });
    const canceled = await client.cancelPayment(created.id);

    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({
      amount: 1500,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({
      amount: 1500,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects a refunded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({
      amount: 1500,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A refunded payment cannot be canceled",
    );
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(
      client.cancelPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment({
      amount: 1500,
      currency: "usd",
      source: "tok_pending",
    });

    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });
});

describe("error body fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_broken",
        () => new HttpResponse("upstream failure", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_broken"), 502, "unknown_error", "Bad Gateway");
  });

  test("uses unknown_error when the JSON error body has no error object", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments/pay_odd", () =>
        HttpResponse.json({ detail: "nope" }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_odd"), 503, "unknown_error", "Service Unavailable");
  });
});
