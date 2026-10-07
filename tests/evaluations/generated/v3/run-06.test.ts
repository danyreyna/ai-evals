import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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

async function captureError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to reject, but it resolved");
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await captureError(promise);
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
}

const createSucceeded = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_visa" });

const createPending = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_pending" });

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
    });

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await createPending();
    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
  });

  test("rejects a zero amount with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ amount: 0, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
    );
  });

  test("rejects a negative amount with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ amount: -5, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
    );
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(
      client.createPayment({ amount: 10.5, currency: "usd", source: "tok_visa" }),
      400,
      "invalid_request",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_unknown" }),
      400,
      "invalid_source",
    );
  });

  test("maps tok_chargeDeclined to 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
  });

  test("maps tok_insufficientFunds to 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
  });

  test("maps tok_serverError to 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });

  test("carries the server message on the error", async () => {
    const error = (await captureError(
      client.createPayment({ amount: 1000, currency: "usd", source: "tok_chargeDeclined" }),
    )) as PaymentsApiError;
    expect(error.name).toBe("PaymentsApiError");
    expect(error.message).toBe("The card was declined");
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await createSucceeded();
    const fetched = await client.getPayment(created.id);
    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createSucceeded();
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await createSucceeded();
    const b = await createPending();
    const list = await client.listPayments();
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await createSucceeded();
    const pending = await createPending();

    const list = await client.listPayments({ status: "pending" });

    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(pending.id);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await createSucceeded();
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await createSucceeded(1000);
    const refunded = await client.refundPayment(created.id);
    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds a payment when an amount is given", async () => {
    const created = await createSucceeded(1000);
    const refunded = await client.refundPayment(created.id, { amount: 400 });
    expect(refunded).toMatchObject({
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id);
    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createSucceeded();
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await createPending();
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(1000);
    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a refund above the remaining amount after a partial refund", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 700 });
    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a zero refund amount with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded();
    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a negative refund amount with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded();
    await expectApiError(
      client.refundPayment(created.id, { amount: -1 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a non-integer refund amount with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded();
    await expectApiError(
      client.refundPayment(created.id, { amount: 10.5 }),
      422,
      "invalid_refund_amount",
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await createPending();
    const canceled = await client.cancelPayment(created.id);
    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("persists the canceled status", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createPending();
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});
