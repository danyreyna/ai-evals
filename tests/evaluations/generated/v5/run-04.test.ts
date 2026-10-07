import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
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
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

const validInput: CreatePaymentInput = { amount: 5000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PaymentsApiError);
  const apiError = caught as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  if (message !== undefined) {
    expect(apiError.message).toBe(message);
  }
}

const createSucceeded = (amount = 5000) => client.createPayment({ ...validInput, amount });
const createPending = () => client.createPayment({ ...validInput, source: "tok_pending" });

describe("createPayment", () => {
  test("creates a succeeded payment from a valid source", async () => {
    const payment = await createSucceeded();

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 5000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment from the pending source", async () => {
    const payment = await createPending();

    expect(payment.status).toBe("pending");
    expect(payment.source).toBe("tok_pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await createSucceeded();

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment(validInput),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test.each([
    ["zero amount", { ...validInput, amount: 0 }],
    ["negative amount", { ...validInput, amount: -100 }],
    ["fractional amount", { ...validInput, amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test.each([
    ["amount", { currency: "usd", source: "tok_visa" }],
    ["currency", { amount: 5000, source: "tok_visa" }],
    ["source", { amount: 5000, currency: "usd" }],
  ])("rejects a missing %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(
      client.createPayment(input as unknown as CreatePaymentInput),
      400,
      "invalid_request",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_unknown" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment matching the id", async () => {
    const first = await createSucceeded(1000);
    const second = await createSucceeded(2000);

    expect(await client.getPayment(second.id)).toEqual(second);
    expect(await client.getPayment(first.id)).toEqual(first);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("encodes the id so a slash cannot reach another route", async () => {
    await expectApiError(client.getPayment("a/refund"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createSucceeded();

    await expectApiError(badKeyClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const succeeded = await createSucceeded();
    const pending = await createPending();

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual(succeeded);
    expect(payments).toContainEqual(pending);
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await createSucceeded();
    const pending = await createPending();

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await createSucceeded();

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes made by other operations", async () => {
    const pending = await createPending();
    await client.cancelPayment(pending.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    const canceled = await client.listPayments({ status: "canceled" });
    expect(canceled.map((p) => p.id)).toEqual([pending.id]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await createSucceeded(5000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 5000,
      amount: 5000,
    });
  });

  test("partially refunds the requested amount", async () => {
    const created = await createSucceeded(5000);

    const refunded = await client.refundPayment(created.id, { amount: 1500 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 1500 });
  });

  test("accumulates partial refunds until the payment is fully refunded", async () => {
    const created = await createSucceeded(5000);

    const first = await client.refundPayment(created.id, { amount: 2000 });
    expect(first).toMatchObject({ status: "partially_refunded", amountRefunded: 2000 });

    const second = await client.refundPayment(created.id, { amount: 3000 });
    expect(second).toMatchObject({ status: "refunded", amountRefunded: 5000 });
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await createSucceeded(5000);
    await client.refundPayment(created.id, { amount: 1200 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 5000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await createSucceeded(5000);
    await client.refundPayment(created.id, { amount: 500 });

    expect(await client.getPayment(created.id)).toMatchObject({
      status: "partially_refunded",
      amountRefunded: 500,
    });
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const pending = await createPending();

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await createPending();
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects a refund above the payment amount with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(5000);

    await expectApiError(
      client.refundPayment(created.id, { amount: 5001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 5000",
    );
  });

  test("rejects a refund above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(5000);
    await client.refundPayment(created.id, { amount: 4000 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await createSucceeded();

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await createSucceeded(5000);
    await expectApiError(
      client.refundPayment(created.id, { amount: 9999 }),
      422,
      "invalid_refund_amount",
    );

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createSucceeded();

    await expectApiError(badKeyClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await createPending();

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toMatchObject({ id: pending.id, status: "canceled", amountRefunded: 0 });
  });

  test("persists the cancellation so getPayment reflects it", async () => {
    const pending = await createPending();
    await client.cancelPayment(pending.id);

    expect((await client.getPayment(pending.id)).status).toBe("canceled");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const pending = await createPending();
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.cancelPayment(pending.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const pending = await createPending();

    await expectApiError(badKeyClient.cancelPayment(pending.id), 401, "unauthorized");
  });
});
