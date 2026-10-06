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

async function rejection(promise: Promise<unknown>): Promise<PaymentsApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentsApiError);
    return error as PaymentsApiError;
  }
  throw new Error("expected promise to reject");
}

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string },
) {
  const error = await rejection(promise);
  expect(error.status).toBe(expected.status);
  expect(error.code).toBe(expected.code);
  expect(error.message.length).toBeGreaterThan(0);
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

  test("rejects an invalid API key with 401", async () => {
    await expectApiError(badClient.createPayment(validInput), {
      status: 401,
      code: "unauthorized",
    });
  });

  test.each([
    ["zero amount", { ...validInput, amount: 0 }],
    ["negative amount", { ...validInput, amount: -100 }],
    ["fractional amount", { ...validInput, amount: 10.5 }],
    ["missing currency", { amount: 100, source: "tok_visa" }],
    ["missing source", { amount: 100, currency: "usd" }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input as typeof validInput), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
    });
  });

  test("surfaces a declined card as 402 card_declined", async () => {
    const error = await rejection(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
    );
    expect(error.status).toBe(402);
    expect(error.code).toBe("card_declined");
    expect(error.message).toBe("The card was declined");
    expect(error.name).toBe("PaymentsApiError");
  });

  test("surfaces insufficient funds as 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
    });
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
    });
  });

  test("does not store a payment when creation fails", async () => {
    await rejection(client.createPayment({ ...validInput, source: "tok_chargeDeclined" }));
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns an existing payment", async () => {
    const created = await client.createPayment(validInput);
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401", async () => {
    await expectApiError(badClient.getPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    const error = await rejection(client.getPayment("pay_missing"));
    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
    expect(error.message).toContain("pay_missing");
  });

  test("encodes ids that contain reserved characters", async () => {
    const error = await rejection(client.getPayment("a/b?c"));
    expect(error.status).toBe(404);
    expect(error.message).toContain("a/b?c");
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

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401", async () => {
    await expectApiError(badClient.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 5000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 2000 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 2000 });
  });

  test("allows successive partial refunds that add up to a full refund", async () => {
    const created = await client.createPayment(validInput);

    await client.refundPayment(created.id, { amount: 2000 });
    const refunded = await client.refundPayment(created.id, { amount: 3000 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 5000 });
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(validInput);

    await client.refundPayment(created.id, { amount: 1000 });
    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 5000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 1000 });

    expect(await client.getPayment(created.id)).toMatchObject({
      status: "partially_refunded",
      amountRefunded: 1000,
    });
  });

  test("rejects an invalid API key with 401", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("returns 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
    });
  });

  test("returns 409 not_refundable for a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
    });
  });

  test("returns 409 not_refundable for a canceled payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
    });
  });

  test.each([
    ["exceeds the payment amount", 5001],
    ["is zero", 0],
    ["is negative", -5],
    ["is fractional", 10.5],
  ])("returns 422 invalid_refund_amount when the amount %s", async (_name, amount) => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("returns 422 when the amount exceeds the remaining balance", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 4000 });

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an invalid API key with 401", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("returns 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
    });
  });

  test("returns 409 not_cancelable for an already canceled payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
    });
  });
});

describe("error fallbacks", () => {
  test("falls back to unknown_error and statusText when the error body is not JSON", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_x",
        () => new HttpResponse("oops", { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    const error = await rejection(client.getPayment("pay_x"));
    expect(error.status).toBe(503);
    expect(error.code).toBe("unknown_error");
    expect(error.message).toBe("Service Unavailable");
  });
});
