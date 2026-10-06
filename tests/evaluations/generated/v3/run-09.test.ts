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

const validInput = { amount: 1000, currency: "usd", source: "tok_visa" };

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("Expected the request to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  expect((error as PaymentsApiError).status).toBe(status);
  expect((error as PaymentsApiError).code).toBe(code);
}

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment(validInput);

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 1000,
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

  test("rejects with 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.createPayment(validInput), 401, "unauthorized");
  });

  test("rejects with 400 invalid_request for a non-positive amount", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, amount: 0 }),
      400,
      "invalid_request",
    );
  });

  test("rejects with 400 invalid_request for a non-integer amount", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, amount: 10.5 }),
      400,
      "invalid_request",
    );
  });

  test("rejects with 400 invalid_request when currency is missing", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as typeof validInput;
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects with 400 invalid_source for an unknown source", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_unknown" }),
      400,
      "invalid_source",
    );
  });

  test("rejects with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
  });

  test("rejects with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
  });

  test("rejects with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });
});

describe("getPayment", () => {
  test("returns an existing payment", async () => {
    const created = await client.createPayment(validInput);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects with 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.getPayment("pay_any"), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const first = await client.createPayment(validInput);
    const second = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("filters payments by status", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const succeededList = await client.listPayments({ status: "succeeded" });
    const pendingList = await client.listPayments({ status: "pending" });
    const refundedList = await client.listPayments({ status: "refunded" });

    expect(succeededList.map((p) => p.id)).toEqual([succeeded.id]);
    expect(pendingList.map((p) => p.id)).toEqual([pending.id]);
    expect(refundedList).toEqual([]);
  });

  test("rejects with 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds a payment", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("completes the refund after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("rejects with 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), 401, "unauthorized");
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects with 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects with 409 not_refundable for a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects with 409 not_refundable for a canceled payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects with 422 invalid_refund_amount when amount exceeds the payment", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects with 422 invalid_refund_amount when amount exceeds the remaining balance", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 800 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 300 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects with 422 invalid_refund_amount for a non-positive amount", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects with 422 invalid_refund_amount for a non-integer amount", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount: 10.5 }),
      422,
      "invalid_refund_amount",
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("rejects with 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), 401, "unauthorized");
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects with 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects with 409 not_cancelable for an already canceled payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});
