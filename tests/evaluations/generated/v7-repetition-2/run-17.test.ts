import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });

const newPayment = (overrides: Partial<CreatePaymentInput> = {}) =>
  client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa", ...overrides });

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  const assertion = expect(promise).rejects;
  await assertion.toBeInstanceOf(PaymentsApiError);
  await assertion.toMatchObject({ name: "PaymentsApiError", status, code });
  if (message !== undefined) {
    await assertion.toHaveProperty("message", message);
  }
}

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

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await newPayment({ amount: 2500, currency: "eur" });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await newPayment({ source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("gives each payment a unique id", async () => {
    const [a, b] = await Promise.all([newPayment(), newPayment()]);

    expect(a.id).not.toBe(b.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      newPayment({ source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      newPayment({ source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      newPayment({ source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      newPayment({ source: "tok_bogus" }),
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
    await expectApiError(newPayment({ amount }), 400, "invalid_request");
  });

  test("rejects a missing source with 400 invalid_request", async () => {
    const input = { amount: 1000, currency: "usd" } as unknown as CreatePaymentInput;

    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await newPayment({ amount: 4200 });

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id so it reaches the server intact", async () => {
    await expectApiError(
      client.getPayment("a/b"),
      404,
      "payment_not_found",
      "No payment with id a/b",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment();
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const succeeded = await newPayment();
    const pending = await newPayment({ source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([succeeded, pending]));
  });

  test("returns only payments matching the status filter", async () => {
    await newPayment();
    const pending = await newPayment({ source: "tok_pending" });

    const payments = await client.listPayments({ status: "pending" });

    expect(payments).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await newPayment();

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await newPayment({ amount: 1000 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amount: 1000,
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await newPayment({ amount: 1000 });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("refunding the remainder after a partial refund completes the refund", async () => {
    const created = await newPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await newPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched).toMatchObject({ status: "partially_refunded", amountRefunded: 250 });
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await newPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await newPayment({ amount: 1000 });

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
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
    const created = await newPayment({ source: "tok_pending" });

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await newPayment({ source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment();
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment({ source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
  });

  test("persists the cancellation so getPayment reflects it", async () => {
    const created = await newPayment({ source: "tok_pending" });
    await client.cancelPayment(created.id);

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("canceled");
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
    const created = await newPayment({ source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment({ source: "tok_pending" });
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });
});
