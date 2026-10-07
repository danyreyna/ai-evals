import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({
  apiKey: "test_key",
  baseUrl: "https://api.example.com/v1",
});
const badClient = new PaymentsClient({
  apiKey: "wrong_key",
  baseUrl: "https://api.example.com/v1",
});

const validInput: CreatePaymentInput = { amount: 1000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  const error = await promise.then(
    () => {
      throw new Error("expected promise to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(expected.status);
  expect(apiError.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(apiError.message).toBe(expected.message);
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
  test("creates a succeeded payment for tok_visa", async () => {
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

  test("sends the bearer token and JSON body", async () => {
    let authorization: string | null = null;
    let contentType: string | null = null;
    let body: unknown;
    server.use(
      http.post("https://api.example.com/v1/payments", async ({ request }) => {
        authorization = request.headers.get("Authorization");
        contentType = request.headers.get("Content-Type");
        body = await request.json();
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await client.createPayment(validInput);

    expect(authorization).toBe("Bearer test_key");
    expect(contentType).toBe("application/json");
    expect(body).toEqual(validInput);
  });

  test("rejects with 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.createPayment(validInput), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });

  test("rejects with 400 invalid_request for a non-positive amount", async () => {
    await expectApiError(client.createPayment({ ...validInput, amount: 0 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects with 400 invalid_request for a non-integer amount", async () => {
    await expectApiError(client.createPayment({ ...validInput, amount: 10.5 }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects with 400 invalid_source for an unknown source", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_unknown" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test("rejects with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects with 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("falls back to unknown_error when the error body is not JSON", async () => {
    server.use(
      http.post(
        "https://api.example.com/v1/payments",
        () => new HttpResponse("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.createPayment(validInput), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await client.createPayment(validInput);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id", async () => {
    await expectApiError(client.getPayment("a/b"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });

  test("rejects with 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.getPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
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

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const onlyPending = await client.listPayments({ status: "pending" });
    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    const onlyCanceled = await client.listPayments({ status: "canceled" });

    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
    expect(onlyCanceled).toEqual([]);
  });

  test("rejects with 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.listPayments(), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds a given amount", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("allows refunding the remainder after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects with 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects with 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects with 409 not_refundable for a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects with 409 not_refundable for a canceled payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects with 422 invalid_refund_amount when exceeding the amount", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects with 422 invalid_refund_amount when exceeding the remaining amount", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 400 });

    await expectApiError(client.refundPayment(created.id, { amount: 601 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 600",
    });
  });

  test("rejects with 422 invalid_refund_amount for a zero amount", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.refundPayment(created.id, { amount: 0 }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects with 422 invalid_refund_amount for a non-integer amount", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.refundPayment(created.id, { amount: 1.5 }), {
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

  test("rejects with 401 unauthorized for an invalid API key", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("rejects with 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects with 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects with 409 not_cancelable for an already canceled payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });
});
