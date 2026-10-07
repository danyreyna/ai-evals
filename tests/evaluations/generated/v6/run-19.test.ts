import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { Payment } from "./index.ts";
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

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  await Promise.all([
    Promise.resolve(expect(promise).rejects.toBeInstanceOf(PaymentsApiError)),
    Promise.resolve(
      expect(promise).rejects.toMatchObject({
        status: expected.status,
        code: expected.code,
        ...(expected.message !== undefined && { message: expected.message }),
      }),
    ),
  ]);
}

function seed(source = "tok_visa", amount = 1000): Promise<Payment> {
  return client.createPayment({ amount, currency: "usd", source });
}

describe("createPayment", () => {
  test("returns a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
    });

    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for tok_pending", async () => {
    const payment = await seed("tok_pending");

    expect(payment.status).toBe("pending");
    expect(payment.amountRefunded).toBe(0);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(seed("tok_chargeDeclined"), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(seed("tok_insufficientFunds"), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(seed("tok_serverError"), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(seed("tok_nope"), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(client.createPayment({ amount, currency: "usd", source: "tok_visa" }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];

    await expectApiError(client.createPayment(input), { status: 400, code: "invalid_request" });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(
      badClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
      { status: 401, code: "unauthorized", message: "Missing or invalid API key" },
    );
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await seed();

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

  test("url-encodes the id so it reaches the server intact", async () => {
    await expectApiError(client.getPayment("a/b c"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b c",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await seed();
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.getPayment(created.id), {
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
    const a = await seed("tok_visa", 100);
    const b = await seed("tok_pending", 200);

    const list = await client.listPayments();

    expect(list).toHaveLength(2);
    expect(list).toContainEqual(a);
    expect(list).toContainEqual(b);
  });

  test("filters by status", async () => {
    const succeeded = await seed("tok_visa");
    const pending = await seed("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await seed("tok_visa");

    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await seed("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await seed("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("accumulates partial refunds and ends as refunded", async () => {
    const created = await seed("tok_visa", 1000);

    await client.refundPayment(created.id, { amount: 400 });
    const final = await client.refundPayment(created.id, { amount: 600 });

    expect(final).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds the remainder of a partially refunded payment when no amount is given", async () => {
    const created = await seed("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 250 });

    const final = await client.refundPayment(created.id);

    expect(final).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await seed("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 300 });

    const fetched = await client.getPayment(created.id);

    expect(fetched).toMatchObject({ status: "partially_refunded", amountRefunded: 300 });
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await seed();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await seed("tok_pending");

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await seed("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects a refund above the payment amount with 422 invalid_refund_amount", async () => {
    const created = await seed("tok_visa", 1000);

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await seed("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(client.refundPayment(created.id, { amount: 400 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 300",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await seed("tok_visa", 1000);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await seed();
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await seed("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled", amountRefunded: 0 });
  });

  test("persists the cancellation so getPayment reflects it", async () => {
    const created = await seed("tok_pending");
    await client.cancelPayment(created.id);

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("canceled");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await seed("tok_visa");

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await seed("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await seed("tok_pending");
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});
