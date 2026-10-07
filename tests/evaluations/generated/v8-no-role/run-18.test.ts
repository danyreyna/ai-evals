import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

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

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

const input = (source: string, amount = 1000) => ({ amount, currency: "usd", source });

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(promise).rejects.toMatchObject({ status, code });
}

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(input("tok_visa"));

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
    const payment = await client.createPayment(input("tok_pending"));

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const promise = client.createPayment(input("tok_chargeDeclined"));

    await expectApiError(promise, 402, "card_declined");
    await expect(promise).rejects.toThrow("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    const promise = client.createPayment(input("tok_insufficientFunds"));

    await expectApiError(promise, 402, "insufficient_funds");
    await expect(promise).rejects.toThrow("The card has insufficient funds");
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    const promise = client.createPayment(input("tok_serverError"));

    await expectApiError(promise, 500, "processing_error");
    await expect(promise).rejects.toThrow("An error occurred while processing the payment");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    const promise = client.createPayment(input("tok_unknown"));

    await expectApiError(promise, 400, "invalid_source");
    await expect(promise).rejects.toThrow("Unknown payment source");
  });

  test("rejects a zero amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment(input("tok_visa", 0)), 400, "invalid_request");
  });

  test("rejects a negative amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment(input("tok_visa", -5)), 400, "invalid_request");
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment(input("tok_visa", 10.5)), 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const promise = badClient.createPayment(input("tok_visa"));

    await expectApiError(promise, 401, "unauthorized");
    await expect(promise).rejects.toThrow("Missing or invalid API key");
  });
});

describe("getPayment", () => {
  test("returns a created payment", async () => {
    const created = await client.createPayment(input("tok_visa"));

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const promise = client.getPayment("pay_missing");

    await expectApiError(promise, 404, "payment_not_found");
    await expect(promise).rejects.toThrow("No payment with id pay_missing");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.getPayment("pay_any"), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await client.createPayment(input("tok_visa"));
    const b = await client.createPayment(input("tok_pending"));

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(input("tok_visa"));
    const pending = await client.createPayment(input("tok_pending"));

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment(input("tok_visa"));

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ id: created.id, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds a payment", async () => {
    const created = await client.createPayment(input("tok_visa"));

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("completes a refund after a partial refund", async () => {
    const created = await client.createPayment(input("tok_visa"));
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects refunding a refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(input("tok_visa"));
    await client.refundPayment(created.id);

    const promise = client.refundPayment(created.id);

    await expectApiError(promise, 409, "already_refunded");
    await expect(promise).rejects.toThrow("Payment already refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(input("tok_pending"));

    const promise = client.refundPayment(created.id);

    await expectApiError(promise, 409, "not_refundable");
    await expect(promise).rejects.toThrow("A pending payment cannot be refunded");
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(input("tok_visa"));

    const promise = client.refundPayment(created.id, { amount: 1001 });

    await expectApiError(promise, 422, "invalid_refund_amount");
    await expect(promise).rejects.toThrow("Refund amount must be between 1 and 1000");
  });

  test("rejects a zero refund amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(input("tok_visa"));

    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a non-integer refund amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(input("tok_visa"));

    await expectApiError(
      client.refundPayment(created.id, { amount: 1.5 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(input("tok_pending"));

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(input("tok_visa"));

    const promise = client.cancelPayment(created.id);

    await expectApiError(promise, 409, "not_cancelable");
    await expect(promise).rejects.toThrow("A succeeded payment cannot be canceled");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(input("tok_pending"));
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), 401, "unauthorized");
  });
});
