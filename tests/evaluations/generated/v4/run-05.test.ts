import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: BASE_URL });

const validInput: CreatePaymentInput = { amount: 1000, currency: "usd", source: "tok_visa" };

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

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  expect((error as PaymentsApiError).status).toBe(status);
  expect((error as PaymentsApiError).code).toBe(code);
  return error as PaymentsApiError;
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

  test("persists the payment so it can be retrieved", async () => {
    const created = await client.createPayment(validInput);

    expect(await client.getPayment(created.id)).toEqual(created);
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
    const error = await expectApiError(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
    expect(error.message).toBe("The card has insufficient funds");
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
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
    ["zero amount", { amount: 0 }],
    ["negative amount", { amount: -5 }],
    ["fractional amount", { amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, override) => {
    await expectApiError(client.createPayment({ ...validInput, ...override }), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as CreatePaymentInput;

    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(badClient.createPayment(validInput), 401, "unauthorized");
  });
});

describe("getPayment", () => {
  test("returns an existing payment", async () => {
    const created = await client.createPayment(validInput);

    const payment = await client.getPayment(created.id);

    expect(payment).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("url-encodes the id in the request path", async () => {
    await expectApiError(client.getPayment("a/b c"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);
    const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
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
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payments = await client.listPayments({ status: "pending" });

    expect(payments).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(validInput);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(validInput);

    const payment = await client.refundPayment(created.id);

    expect(payment).toMatchObject({ id: created.id, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds a specific amount", async () => {
    const created = await client.createPayment(validInput);

    const payment = await client.refundPayment(created.id, { amount: 400 });

    expect(payment).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("completes a refund across two partial refunds", async () => {
    const created = await client.createPayment(validInput);

    await client.refundPayment(created.id, { amount: 400 });
    const payment = await client.refundPayment(created.id, { amount: 600 });

    expect(payment).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds the remaining balance of a partially refunded payment", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 250 });

    const payment = await client.refundPayment(created.id);

    expect(payment).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    const error = await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
    expect(error.message).toBe("Payment already refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    const error = await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 800 });

    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 300 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 200");
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);
    const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payment = await client.cancelPayment(created.id);

    expect(payment).toMatchObject({ id: created.id, status: "canceled" });
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(validInput);

    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });
});

describe("error fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () => new HttpResponse("oops", { status: 503 })),
    );

    await expectApiError(client.getPayment("pay_any"), 503, "unknown_error");
  });
});
