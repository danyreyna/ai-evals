import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

const validInput: CreatePaymentInput = { amount: 1000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  if (message !== undefined) {
    expect(apiError.message).toBe(message);
  }
}

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
    expect(new Date(payment.createdAt).toString()).not.toBe("Invalid Date");
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await client.createPayment(validInput);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment(validInput),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test.each([
    ["a zero amount", { ...validInput, amount: 0 }],
    ["a negative amount", { ...validInput, amount: -5 }],
    ["a non-integer amount", { ...validInput, amount: 10.5 }],
    ["a missing currency", { amount: 1000, source: "tok_visa" }],
    ["a missing source", { amount: 1000, currency: "usd" }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input as CreatePaymentInput), 400, "invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_unknown" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns an existing payment", async () => {
    const created = await client.createPayment(validInput);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id in the request path", async () => {
    let requestedPath = "";
    server.use(
      http.get(`${BASE_URL}/payments/:id`, ({ request }) => {
        requestedPath = new URL(request.url).pathname;
        return HttpResponse.json(
          { error: { code: "payment_not_found", message: "nope" } },
          { status: 404 },
        );
      }),
    );

    await expectApiError(client.getPayment("a/b c"), 404, "payment_not_found");
    expect(requestedPath).toBe("/v1/payments/a%2Fb%20c");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.getPayment("pay_any"), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment(validInput);
    const b = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual(a);
    expect(payments).toContainEqual(b);
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ id: created.id, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds a payment", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("completes a refund across multiple partial refunds", async () => {
    const created = await client.createPayment(validInput);

    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 250 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 400 });

    expect(await client.getPayment(created.id)).toMatchObject({
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 10.5],
    ["greater than the payment amount", 1001],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects a refund above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 800 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 300 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 200",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.refundPayment("pay_any"), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("persists the cancellation", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.cancelPayment("pay_any"), 401, "unauthorized");
  });
});

describe("error fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });
});
