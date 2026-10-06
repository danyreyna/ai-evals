import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });

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

async function rejectionOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string },
) {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(PaymentsApiError);
  expect(error).toMatchObject(expected);
}

const visa = { amount: 1000, currency: "usd", source: "tok_visa" };

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment(visa);

    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...visa, source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid API key with 401", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.createPayment(visa), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("rejects a non-positive amount with 400", async () => {
    await expectApiError(client.createPayment({ ...visa, amount: 0 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a non-integer amount with 400", async () => {
    await expectApiError(client.createPayment({ ...visa, amount: 10.5 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects an unknown source with 400", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_unknown" }), {
      status: 400,
      code: "invalid_source",
    });
  });

  test("surfaces a declined card as 402", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
    });
  });

  test("surfaces insufficient funds as 402", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
    });
  });

  test("surfaces a processing failure as 500", async () => {
    await expectApiError(client.createPayment({ ...visa, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
    });
  });
});

describe("getPayment", () => {
  test("returns an existing payment", async () => {
    const created = await client.createPayment(visa);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects an invalid API key with 401", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.getPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const first = await client.createPayment(visa);
    const second = await client.createPayment({ ...visa, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("filters by status", async () => {
    await client.createPayment(visa);
    const pending = await client.createPayment({ ...visa, source: "tok_pending" });

    const payments = await client.listPayments({ status: "pending" });

    expect(payments).toEqual([pending]);
  });

  test("returns an empty list when no payment matches the status", async () => {
    await client.createPayment(visa);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.listPayments(), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds a payment", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("completes a refund across two partial refunds", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects a refund of an already refunded payment with 409", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
    });
  });

  test("rejects a refund of a pending payment with 409", async () => {
    const created = await client.createPayment({ ...visa, source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
    });
  });

  test("rejects a refund of a canceled payment with 409", async () => {
    const created = await client.createPayment({ ...visa, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
    });
  });

  test("rejects a refund larger than the remaining amount with 422", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects a zero refund amount with 422", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.refundPayment(created.id, { amount: 0 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects a refund exceeding what is left after a partial refund", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 800 });

    await expectApiError(client.refundPayment(created.id, { amount: 300 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects an invalid API key with 401", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.refundPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...visa, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("rejects an unknown id with 404", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects canceling a succeeded payment with 409", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
    });
  });

  test("rejects canceling an already canceled payment with 409", async () => {
    const created = await client.createPayment({ ...visa, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
    });
  });

  test("rejects an invalid API key with 401", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key" });

    await expectApiError(badClient.cancelPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_broken",
        () => new HttpResponse("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    const error = await rejectionOf(client.getPayment("pay_broken"));

    expect(error).toBeInstanceOf(PaymentsApiError);
    expect(error).toMatchObject({
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });
});
