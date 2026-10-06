import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
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

const createInput = { amount: 5000, currency: "usd", source: "tok_visa" };

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("Expected the call to reject");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  expect((error as PaymentsApiError).status).toBe(status);
  expect((error as PaymentsApiError).code).toBe(code);
  return error as PaymentsApiError;
}

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(createInput);

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
    const payment = await client.createPayment({ ...createInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const error = await expectApiError(
      client.createPayment({ ...createInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
    expect(error.message).toBe("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...createInput, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...createInput, source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...createInput, source: "tok_bogus" }),
      400,
      "invalid_source",
    );
  });

  test.each([
    ["zero amount", { ...createInput, amount: 0 }],
    ["negative amount", { ...createInput, amount: -100 }],
    ["fractional amount", { ...createInput, amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.createPayment(createInput), 401, "unauthorized");
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment(createInput);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(createInput);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments when no filter is given", async () => {
    const first = await client.createPayment(createInput);
    const second = await client.createPayment({ ...createInput, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("filters payments by status", async () => {
    const succeeded = await client.createPayment(createInput);
    const pending = await client.createPayment({ ...createInput, source: "tok_pending" });

    const pendingOnly = await client.listPayments({ status: "pending" });
    const succeededOnly = await client.listPayments({ status: "succeeded" });
    const refundedOnly = await client.listPayments({ status: "refunded" });

    expect(pendingOnly.map((p: Payment) => p.id)).toEqual([pending.id]);
    expect(succeededOnly.map((p: Payment) => p.id)).toEqual([succeeded.id]);
    expect(refundedOnly).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment(createInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(5000);
  });

  test("partially refunds a payment when an amount is given", async () => {
    const created = await client.createPayment(createInput);

    const refunded = await client.refundPayment(created.id, { amount: 1500 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(1500);
  });

  test("allows several partial refunds that add up to a full refund", async () => {
    const created = await client.createPayment(createInput);

    await client.refundPayment(created.id, { amount: 2000 });
    const refunded = await client.refundPayment(created.id, { amount: 3000 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(5000);
  });

  test("refunds only the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(createInput);
    await client.refundPayment(created.id, { amount: 1000 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(5000);
  });

  test("rejects a refund of an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(createInput);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects a refund of a pending payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...createInput, source: "tok_pending" });

    const error = await expectApiError(client.refundPayment(pending.id), 409, "not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects a refund of a canceled payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...createInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.refundPayment(pending.id), 409, "not_refundable");
  });

  test.each([
    ["more than the payment amount", { amount: 5001 }],
    ["zero", { amount: 0 }],
    ["a negative amount", { amount: -1 }],
    ["a fractional amount", { amount: 10.5 }],
  ])("rejects a refund of %s with 422 invalid_refund_amount", async (_name, input) => {
    const created = await client.createPayment(createInput);

    await expectApiError(client.refundPayment(created.id, input), 422, "invalid_refund_amount");
  });

  test("rejects a refund above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(createInput);
    await client.refundPayment(created.id, { amount: 4000 });

    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 1000");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(createInput);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await client.createPayment({ ...createInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled.id).toBe(pending.id);
    expect(canceled.status).toBe("canceled");
  });

  test("persists the cancellation", async () => {
    const pending = await client.createPayment({ ...createInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    expect((await client.getPayment(pending.id)).status).toBe("canceled");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(createInput);

    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const pending = await client.createPayment({ ...createInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.cancelPayment(pending.id), 409, "not_cancelable");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const pending = await client.createPayment({ ...createInput, source: "tok_pending" });
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.cancelPayment(pending.id), 401, "unauthorized");
  });
});

describe("error handling", () => {
  test("is a PaymentsApiError carrying name, status, code and message", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PaymentsApiError");
  });
});
