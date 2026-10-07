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

const expectApiError = async (
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) => {
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(promise).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
};

const createSucceeded = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_visa" });

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const before = Date.now();
    const payment = await client.createPayment({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
    });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_.+/),
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(new Date(payment.createdAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({
      amount: 700,
      currency: "eur",
      source: "tok_pending",
    });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(700);
    expect(payment.currency).toBe("eur");
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await createSucceeded();
    const second = await createSucceeded();

    expect(first.id).not.toBe(second.id);
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

  test("rejects a missing api key with 401 unauthorized", async () => {
    const anonymous = new PaymentsClient({ apiKey: "" });

    await expectApiError(
      anonymous.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test("rejects a wrong api key with 401 unauthorized", async () => {
    const wrong = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(
      wrong.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await createSucceeded(4200);

    await expect(client.getPayment(created.id)).resolves.toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id so a slash cannot reach another route", async () => {
    await expectApiError(
      client.getPayment("a/refund"),
      404,
      "payment_not_found",
      "No payment with id a/refund",
    );
  });

  test("rejects a wrong api key with 401 unauthorized", async () => {
    const created = await createSucceeded();
    const wrong = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(wrong.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    await expect(client.listPayments()).resolves.toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const succeeded = await createSucceeded(100);
    const pending = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });

    const list = await client.listPayments();

    expect(list).toHaveLength(2);
    expect(list).toEqual(expect.arrayContaining([succeeded, pending]));
  });

  test("filters by status", async () => {
    await createSucceeded(100);
    const pending = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });

    await expect(client.listPayments({ status: "pending" })).resolves.toEqual([pending]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await createSucceeded();

    await expect(client.listPayments({ status: "canceled" })).resolves.toEqual([]);
  });

  test("reflects status changes made through refund and cancel", async () => {
    const toRefund = await createSucceeded(100);
    const toCancel = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });
    const refunded = await client.refundPayment(toRefund.id);
    const canceled = await client.cancelPayment(toCancel.id);

    await expect(client.listPayments({ status: "refunded" })).resolves.toEqual([refunded]);
    await expect(client.listPayments({ status: "canceled" })).resolves.toEqual([canceled]);
    await expect(client.listPayments({ status: "succeeded" })).resolves.toEqual([]);
  });

  test("rejects a wrong api key with 401 unauthorized", async () => {
    const wrong = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(wrong.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await createSucceeded(1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("accumulates partial refunds until the payment is fully refunded", async () => {
    const created = await createSucceeded(1000);

    const first = await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });

    expect(first.status).toBe("partially_refunded");
    expect(first.amountRefunded).toBe(400);
    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("refunds only the remainder after a partial refund when no amount is given", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 300 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await createSucceeded(1000);
    const refunded = await client.refundPayment(created.id, { amount: 250 });

    await expect(client.getPayment(created.id)).resolves.toEqual(refunded);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects a refund above the amount remaining with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 400 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 601 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 600",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await createSucceeded(1000);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("a rejected refund leaves the payment unchanged", async () => {
    const created = await createSucceeded(1000);
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    await expect(client.getPayment(created.id)).resolves.toEqual(created);
  });

  test("rejects a wrong api key with 401 unauthorized", async () => {
    const created = await createSucceeded();
    const wrong = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(wrong.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled).toEqual({ ...pending, status: "canceled" });
  });

  test("persists the cancellation so getPayment sees it", async () => {
    const pending = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });
    const canceled = await client.cancelPayment(pending.id);

    await expect(client.getPayment(pending.id)).resolves.toEqual(canceled);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.cancelPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
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
    const pending = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.cancelPayment(pending.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects a wrong api key with 401 unauthorized", async () => {
    const pending = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_pending",
    });
    const wrong = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(wrong.cancelPayment(pending.id), 401, "unauthorized");
  });
});
