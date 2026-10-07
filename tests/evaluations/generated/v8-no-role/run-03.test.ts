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

const newPayment = { amount: 1000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  call: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject(expected);
}

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(newPayment);

    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...newPayment, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...newPayment, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...newPayment, source: "tok_insufficientFunds" }),
      {
        status: 402,
        code: "insufficient_funds",
        message: "The card has insufficient funds",
      },
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...newPayment, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...newPayment, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test("rejects a non-positive amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment({ ...newPayment, amount: 0 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment({ ...newPayment, amount: 10.5 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.createPayment(newPayment), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment(newPayment);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.getPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const first = await client.createPayment(newPayment);
    const second = await client.createPayment({ ...newPayment, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual(first);
    expect(payments).toContainEqual(second);
  });

  test("filters payments by status", async () => {
    const succeeded = await client.createPayment(newPayment);
    const pending = await client.createPayment({ ...newPayment, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment(newPayment);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds, then fully refunds the remainder", async () => {
    const created = await client.createPayment(newPayment);

    const partial = await client.refundPayment(created.id, { amount: 400 });
    expect(partial).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });

    const rest = await client.refundPayment(created.id);
    expect(rest).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(newPayment);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...newPayment, source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(newPayment);
    await client.refundPayment(created.id, { amount: 400 });

    await expectApiError(client.refundPayment(created.id, { amount: 601 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 600",
    });
  });

  test("rejects a zero refund amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(newPayment);

    await expectApiError(client.refundPayment(created.id, { amount: 0 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...newPayment, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(newPayment);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...newPayment, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});
