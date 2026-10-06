import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to reject");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  expect((error as PaymentsApiError).status).toBe(status);
  expect((error as PaymentsApiError).code).toBe(code);
}

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

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment({
      amount: 2000,
      currency: "usd",
      source: "tok_visa",
    });

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 2000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });

    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
  });

  test.each([
    ["zero amount", { amount: 0, currency: "usd", source: "tok_visa" }],
    ["negative amount", { amount: -5, currency: "usd", source: "tok_visa" }],
    ["fractional amount", { amount: 10.5, currency: "usd", source: "tok_visa" }],
    ["non-numeric amount", { amount: "10", currency: "usd", source: "tok_visa" }],
    ["missing currency", { amount: 100, source: "tok_visa" }],
    ["missing source", { amount: 100, currency: "usd" }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(
      client.createPayment(input as Parameters<PaymentsClient["createPayment"]>[0]),
      400,
      "invalid_request",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_unknown" }),
      400,
      "invalid_source",
    );
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment({
      amount: 1500,
      currency: "eur",
      source: "tok_visa",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.getPayment("pay_any"), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("url-encodes the id and still reports 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("a/b?c"), 404, "payment_not_found");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const b = await client.createPayment({ amount: 200, currency: "usd", source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
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

    const onlyPending = await client.listPayments({ status: "pending" });
    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    const onlyCanceled = await client.listPayments({ status: "canceled" });

    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
    expect(onlyCanceled).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("completes a refund across multiple partial refunds", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    await client.refundPayment(created.id, { amount: 400 });
    const final = await client.refundPayment(created.id, { amount: 600 });

    expect(final).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds only the remainder after a partial refund", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    await client.refundPayment(created.id, { amount: 300 });
    const final = await client.refundPayment(created.id);

    expect(final).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toMatchObject({
      status: "partially_refunded",
      amountRefunded: 250,
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test.each([
    ["zero", 0],
    ["negative", -10],
    ["fractional", 10.5],
    ["more than the payment amount", 1001],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a refund larger than the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect(await client.getPayment(created.id)).toMatchObject({ status: "canceled" });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_visa",
    });

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});
