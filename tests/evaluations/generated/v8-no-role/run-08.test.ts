import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
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

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(promise).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
}

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment({ amount: 2500, currency: "usd", source: "tok_visa" });

    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await newPayment("tok_pending");

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("rejects a non-positive amount with 400 invalid_request", async () => {
    await expectApiError(
      newPayment("tok_visa", 0),
      400,
      "invalid_request",
      "amount (positive integer), currency and source are required",
    );
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(newPayment("tok_visa", 10.5), 400, "invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      newPayment("tok_unknown"),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test("maps tok_chargeDeclined to 402 card_declined", async () => {
    await expectApiError(
      newPayment("tok_chargeDeclined"),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("maps tok_insufficientFunds to 402 insufficient_funds", async () => {
    await expectApiError(
      newPayment("tok_insufficientFunds"),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("maps tok_serverError to 500 processing_error", async () => {
    await expectApiError(
      newPayment("tok_serverError"),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });
});

describe("getPayment", () => {
  test("returns a created payment", async () => {
    const created = await newPayment();

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
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const first = await newPayment();
    const second = await newPayment("tok_pending");

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([first, second]));
  });

  test("filters by status", async () => {
    const succeeded = await newPayment();
    await newPayment("tok_pending");

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty list when no payment matches the status", async () => {
    await newPayment();

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("completes a partial refund with a second refund", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await newPayment();
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 601 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 600",
    );
  });

  test("rejects a zero amount with 422 invalid_refund_amount", async () => {
    const created = await newPayment();

    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a non-integer amount with 422 invalid_refund_amount", async () => {
    const created = await newPayment();

    await expectApiError(
      client.refundPayment(created.id, { amount: 1.5 }),
      422,
      "invalid_refund_amount",
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await newPayment();

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });
});

describe("authentication", () => {
  const badClient = new PaymentsClient({ apiKey: "wrong_key" });
  const message = "Missing or invalid API key";

  test("createPayment rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      message,
    );
  });

  test("getPayment rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(badClient.getPayment("pay_any"), 401, "unauthorized", message);
  });

  test("listPayments rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized", message);
  });

  test("refundPayment rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), 401, "unauthorized", message);
  });

  test("cancelPayment rejects a bad key with 401 unauthorized", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), 401, "unauthorized", message);
  });
});
