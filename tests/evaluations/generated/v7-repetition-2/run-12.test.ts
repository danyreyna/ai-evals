/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-argument, typescript/await-thenable -- bun:test types asymmetric matchers as any and `rejects` as non-thenable */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });

const validInput: CreatePaymentInput = { amount: 1000, currency: "usd", source: "tok_visa" };

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

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  await expect(promise).rejects.toBeInstanceOf(PaymentsApiError);
  await expect(promise).rejects.toMatchObject(expected);
}

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment(validInput);

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for the pending source", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(1000);
    expect(payment.amountRefunded).toBe(0);
  });

  test("gives each payment a unique id", async () => {
    const first = await client.createPayment(validInput);
    const second = await client.createPayment(validInput);

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero amount", { ...validInput, amount: 0 }],
    ["negative amount", { ...validInput, amount: -5 }],
    ["fractional amount", { ...validInput, amount: 10.5 }],
    ["missing currency", { amount: 1000, source: "tok_visa" }],
    ["missing source", { amount: 1000, currency: "usd" }],
    ["string amount", { ...validInput, amount: "1000" }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input as unknown as CreatePaymentInput), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.createPayment(validInput), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(validInput);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id so it cannot change the route", async () => {
    await expectApiError(client.getPayment("a/b"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.getPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(validInput);
    const b = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds by default", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("accumulates partial refunds and ends as refunded", async () => {
    const created = await client.createPayment(validInput);

    await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });

    expect(second).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
  });

  test("refunds only the remainder after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 250 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 300 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(300);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.refundPayment(pending.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test.each([
    ["more than the remaining balance", 1001],
    ["zero", 0],
    ["a negative amount", -1],
    ["a fractional amount", 10.5],
  ])("rejects a refund of %s with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a refund above the remainder after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(client.refundPayment(created.id, { amount: 301 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 300",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.refundPayment(created.id), {
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

  test("persists the cancellation so getPayment sees it", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    const fetched = await client.getPayment(pending.id);

    expect(fetched.status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(pending.id);

    await expectApiError(client.cancelPayment(pending.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.cancelPayment(pending.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_x",
        () => new HttpResponse("upstream failure", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_x"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });
});
