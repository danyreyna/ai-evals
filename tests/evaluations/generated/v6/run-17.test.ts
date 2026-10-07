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

const validInput = { amount: 5000, currency: "usd", source: "tok_visa" };

describe("createPayment", () => {
  test("returns a succeeded payment echoing the input", async () => {
    const payment = await client.createPayment(validInput);

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

  test("returns a pending payment for the tok_pending source", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment(validInput);
    const second = await client.createPayment(validInput);

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a non-positive amount with 400 invalid_request", async () => {
    const error = await client
      .createPayment({ ...validInput, amount: 0 })
      .then(
        () => {
          throw new Error("expected createPayment to reject");
        },
        (e: unknown) => e,
      );

    expect(error).toBeInstanceOf(PaymentsApiError);
    expect(error).toMatchObject({ status: 400, code: "invalid_request" });
  });

  test("rejects a fractional amount with 400 invalid_request", async () => {
    await expect(client.createPayment({ ...validInput, amount: 10.5 })).rejects.toMatchObject({
      name: "PaymentsApiError",
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    const promise = client.createPayment({ ...validInput, source: "tok_bogus" });

    await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
    await expect(promise).rejects.toMatchObject({
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expect(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
    ).rejects.toMatchObject({
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expect(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
    ).rejects.toMatchObject({
      status: 402,
      code: "insufficient_funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expect(
      client.createPayment({ ...validInput, source: "tok_serverError" }),
    ).rejects.toMatchObject({
      status: 500,
      code: "processing_error",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expect(badClient.createPayment(validInput)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });

  test("does not store a payment when creation is declined", async () => {
    await expect(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
    ).rejects.toMatchObject({ status: 402, code: "card_declined" });

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await client.createPayment(validInput);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expect(client.getPayment("pay_missing")).rejects.toMatchObject({
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id so it reaches the server intact", async () => {
    await expect(client.getPayment("a/b c")).rejects.toMatchObject({
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b c",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);

    await expect(badClient.getPayment(created.id)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when no payments exist", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(validInput);
    const b = await client.createPayment({ ...validInput, source: "tok_pending" });

    const list = await client.listPayments();

    expect(list).toHaveLength(2);
    expect(list).toEqual(expect.arrayContaining([a, b]));
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(validInput);

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("reflects status changes made by refund and cancel", async () => {
    const toRefund = await client.createPayment(validInput);
    const toCancel = await client.createPayment({ ...validInput, source: "tok_pending" });
    const refunded = await client.refundPayment(toRefund.id);
    const canceled = await client.cancelPayment(toCancel.id);

    expect(await client.listPayments({ status: "refunded" })).toEqual([refunded]);
    expect(await client.listPayments({ status: "canceled" })).toEqual([canceled]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expect(badClient.listPayments()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 5000 });
  });

  test("partially refunds the requested amount", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 2000 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 2000 });
  });

  test("accumulates partial refunds until the payment is fully refunded", async () => {
    const created = await client.createPayment(validInput);

    const first = await client.refundPayment(created.id, { amount: 2000 });
    const second = await client.refundPayment(created.id, { amount: 3000 });

    expect(first.status).toBe("partially_refunded");
    expect(second).toEqual({ ...created, status: "refunded", amountRefunded: 5000 });
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 1200 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 5000 });
  });

  test("persists the refund so getPayment returns it", async () => {
    const created = await client.createPayment(validInput);
    const refunded = await client.refundPayment(created.id, { amount: 100 });

    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expect(client.refundPayment("pay_missing")).rejects.toMatchObject({
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expect(client.refundPayment(created.id)).rejects.toMatchObject({
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects a pending payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expect(client.refundPayment(pending.id)).rejects.toMatchObject({
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects a canceled payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expect(client.refundPayment(pending.id)).rejects.toMatchObject({
      status: 409,
      code: "not_refundable",
    });
  });

  test("rejects an amount above the payment total with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);

    await expect(client.refundPayment(created.id, { amount: 5001 })).rejects.toMatchObject({
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 5000",
    });
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 4000 });

    await expect(client.refundPayment(created.id, { amount: 1001 })).rejects.toMatchObject({
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a zero amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);

    await expect(client.refundPayment(created.id, { amount: 0 })).rejects.toMatchObject({
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects a fractional amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);

    await expect(client.refundPayment(created.id, { amount: 10.5 })).rejects.toMatchObject({
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(validInput);

    await expect(client.refundPayment(created.id, { amount: 9999 })).rejects.toMatchObject({
      status: 422,
      code: "invalid_refund_amount",
    });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);

    await expect(badClient.refundPayment(created.id)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toEqual({ ...pending, status: "canceled" });
  });

  test("persists the cancellation so getPayment returns it", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    const canceled = await client.cancelPayment(pending.id);

    expect(await client.getPayment(pending.id)).toEqual(canceled);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expect(client.cancelPayment("pay_missing")).rejects.toMatchObject({
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(validInput);

    await expect(client.cancelPayment(created.id)).rejects.toMatchObject({
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects an already canceled payment with 409 not_cancelable", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expect(client.cancelPayment(pending.id)).rejects.toMatchObject({
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expect(badClient.cancelPayment(pending.id)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });
});
