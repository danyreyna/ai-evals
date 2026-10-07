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

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<PaymentsApiError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to reject");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  expect(apiError.name).toBe("PaymentsApiError");
  return apiError;
}

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment(validInput);

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

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });
    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const error = await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
    expect(error.message).toBe("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
  });

  test("surfaces a 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_unknown" }),
      400,
      "invalid_source",
    );
  });

  test.each([
    ["zero amount", { ...validInput, amount: 0 }],
    ["negative amount", { ...validInput, amount: -100 }],
    ["fractional amount", { ...validInput, amount: 10.5 }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as typeof validInput;
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.createPayment(validInput), 401, "unauthorized");
  });
});

describe("getPayment", () => {
  test("returns an existing payment", async () => {
    const created = await client.createPayment(validInput);
    const fetched = await client.getPayment(created.id);
    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("url-encodes the id", async () => {
    const error = await expectApiError(client.getPayment("a/b c"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id a/b c");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.getPayment("pay_any"), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await client.createPayment(validInput);
    const b = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payments = await client.listPayments();
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const onlyPending = await client.listPayments({ status: "pending" });
    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);

    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(validInput);
    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(5000);
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(validInput);
    const refunded = await client.refundPayment(created.id, { amount: 2000 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(2000);
  });

  test("completes a refund across multiple partial refunds", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 2000 });
    const refunded = await client.refundPayment(created.id, { amount: 3000 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(5000);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    const error = await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test.each([
    ["exceeds the remaining balance", 5001],
    ["is zero", 0],
    ["is negative", -1],
    ["is fractional", 10.5],
  ])("rejects an amount that %s with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(validInput);
    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an amount above what remains after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 4000 });
    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 1000");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(validInput);
    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), 401, "unauthorized");
  });
});
