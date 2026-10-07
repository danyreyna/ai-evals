import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

const input = (overrides: Partial<CreatePaymentInput> = {}): CreatePaymentInput => ({
  amount: 1000,
  currency: "usd",
  source: "tok_visa",
  ...overrides,
});

async function expectApiError(
  call: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  await expect(call).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(call).rejects.toMatchObject({
    name: "PaymentsApiError",
    status,
    code,
    ...(message !== undefined && { message }),
  });
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
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(input());

    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(new Date(payment.createdAt).toISOString()).toBe(payment.createdAt);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment(input({ source: "tok_pending" }));

    expect(payment.status).toBe("pending");
    expect(payment.source).toBe("tok_pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_chargeDeclined" })),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_insufficientFunds" })),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_serverError" })),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment(input({ source: "tok_bogus" })),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test("rejects a zero amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment(input({ amount: 0 })), 400, "invalid_request");
  });

  test("rejects a negative amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment(input({ amount: -5 })), 400, "invalid_request");
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment(input({ amount: 10.5 })), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const bad = { amount: 1000, source: "tok_visa" } as unknown as CreatePaymentInput;
    await expectApiError(client.createPayment(bad), 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment(input()),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment(input({ amount: 2500, currency: "eur" }));

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

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(input());

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(input());
    const b = await client.createPayment(input({ source: "tok_pending" }));

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(input());
    const pending = await client.createPayment(input({ source: "tok_pending" }));

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(input());
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects an amount above what remains after a partial refund with 422", async () => {
    const created = await client.createPayment(input({ amount: 1000 }));
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 301 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });

  test("rejects a zero amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(input());

    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a non-integer amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(input());

    await expectApiError(
      client.refundPayment(created.id, { amount: 1.5 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(input());

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(input());

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.cancelPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(input({ source: "tok_pending" }));

    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });
});
