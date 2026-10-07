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
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

const card = { amount: 5000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  call: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status: expected.status,
    code: expected.code,
    ...(expected.message !== undefined && { message: expected.message }),
  });
}

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card source", async () => {
    const payment = await client.createPayment(card);

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 5000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for the pending source", async () => {
    const payment = await client.createPayment({ ...card, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(5000);
    expect(payment.amountRefunded).toBe(0);
  });

  test("returns distinct ids for separate payments", async () => {
    const first = await client.createPayment(card);
    const second = await client.createPayment(card);

    expect(first.id).not.toBe(second.id);
  });

  test("throws 402 card_declined for a declined card", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("throws 402 insufficient_funds when the card lacks funds", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("throws 500 processing_error on a server failure", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("throws 400 invalid_source for an unknown source", async () => {
    await expectApiError(client.createPayment({ ...card, source: "tok_bogus" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test("throws 400 invalid_request for a zero amount", async () => {
    await expectApiError(client.createPayment({ ...card, amount: 0 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("throws 400 invalid_request for a negative amount", async () => {
    await expectApiError(client.createPayment({ ...card, amount: -100 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("throws 400 invalid_request for a non-integer amount", async () => {
    await expectApiError(client.createPayment({ ...card, amount: 10.5 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("throws 400 invalid_request when currency is missing", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as typeof card;

    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("throws 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.createPayment(card), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(card);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("reflects the current status after a state change", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    const fetched = await client.getPayment(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.status).toBe("canceled");
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("encodes special characters in the id", async () => {
    await expectApiError(client.getPayment("a/b c"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b c",
    });
  });

  test("throws 401 unauthorized for an invalid API key", async () => {
    const created = await client.createPayment(card);

    await expectApiError(badClient.getPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    const payments = await client.listPayments();

    expect(payments).toEqual([]);
  });

  test("returns every created payment", async () => {
    const first = await client.createPayment(card);
    const second = await client.createPayment({ ...card, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual(first);
    expect(payments).toContainEqual(second);
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment(card);
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    const pendingList = await client.listPayments({ status: "pending" });
    const succeededList = await client.listPayments({ status: "succeeded" });

    expect(pendingList).toEqual([pending]);
    expect(succeededList).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(card);

    const payments = await client.listPayments({ status: "refunded" });

    expect(payments).toEqual([]);
  });

  test("throws 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.listPayments(), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 5000 });
  });

  test("partially refunds a payment when an amount is given", async () => {
    const created = await client.createPayment(card);

    const refunded = await client.refundPayment(created.id, { amount: 2000 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 2000 });
  });

  test("accumulates partial refunds until the payment is fully refunded", async () => {
    const created = await client.createPayment(card);

    const afterFirst = await client.refundPayment(created.id, { amount: 2000 });
    const afterSecond = await client.refundPayment(created.id, { amount: 3000 });

    expect(afterFirst.status).toBe("partially_refunded");
    expect(afterFirst.amountRefunded).toBe(2000);
    expect(afterSecond.status).toBe("refunded");
    expect(afterSecond.amountRefunded).toBe(5000);
  });

  test("refunds only the remainder after a partial refund", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 1500 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(5000);
  });

  test("persists the refund so getPayment returns it", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 1000 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(1000);
  });

  test("throws 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("throws 409 not_refundable for a pending payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("throws 409 not_refundable for a canceled payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("throws 422 invalid_refund_amount when the amount exceeds the payment", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount: 5001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 5000",
    });
  });

  test("throws 422 invalid_refund_amount when the amount exceeds the remainder", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 4000 });

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("throws 422 invalid_refund_amount for a zero amount", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount: 0 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("throws 422 invalid_refund_amount for a negative amount", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.refundPayment(created.id, { amount: -1 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("throws 401 unauthorized for an invalid API key", async () => {
    const created = await client.createPayment(card);

    await expectApiError(badClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment returns it", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("canceled");
  });

  test("throws 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(card);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("throws 409 not_cancelable for an already canceled payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("throws 409 not_cancelable for a refunded payment", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A refunded payment cannot be canceled",
    });
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("throws 401 unauthorized for an invalid API key", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });

    await expectApiError(badClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});
