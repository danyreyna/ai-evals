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

const visa: CreatePaymentInput = { amount: 1000, currency: "usd", source: "tok_visa" };
const pending: CreatePaymentInput = { amount: 1000, currency: "usd", source: "tok_pending" };

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<PaymentsApiError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to be rejected");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  return apiError;
}

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(visa);

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
    const payment = await client.createPayment(pending);

    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const error = await expectApiError(
      client.createPayment({ ...visa, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
    expect(error.message).toBe("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    const error = await expectApiError(
      client.createPayment({ ...visa, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
    expect(error.message).toBe("The card has insufficient funds");
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...visa, source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...visa, source: "tok_unknown" }),
      400,
      "invalid_source",
    );
  });

  test.each([
    ["zero amount", { ...visa, amount: 0 }],
    ["negative amount", { ...visa, amount: -5 }],
    ["fractional amount", { ...visa, amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as CreatePaymentInput;

    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    const error = await expectApiError(badClient.createPayment(visa), 401, "unauthorized");
    expect(error.message).toBe("Missing or invalid API key");
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment(visa);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("encodes the id in the request path", async () => {
    const error = await expectApiError(client.getPayment("a/b c"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id a/b c");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments when no filter is given", async () => {
    const a = await client.createPayment(visa);
    const b = await client.createPayment(pending);

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters payments by status", async () => {
    const succeeded = await client.createPayment(visa);
    const waiting = await client.createPayment(pending);

    expect(await client.listPayments({ status: "pending" })).toEqual([waiting]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds a payment and tracks the running total", async () => {
    const created = await client.createPayment(visa);

    const first = await client.refundPayment(created.id, { amount: 400 });
    expect(first.status).toBe("partially_refunded");
    expect(first.amountRefunded).toBe(400);

    const second = await client.refundPayment(created.id, { amount: 600 });
    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 250 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id);

    const error = await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
    expect(error.message).toBe("Payment already refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);

    const error = await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test.each([
    ["exceeds the remaining balance", 1001],
    ["is zero", 0],
    ["is negative", -1],
    ["is fractional", 10.5],
  ])("rejects a refund amount that %s with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(visa);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a refund above the balance left after a partial refund", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 900 });

    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 200 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 100");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(pending);

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("persists the canceled status", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa);

    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(pending);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });
});
