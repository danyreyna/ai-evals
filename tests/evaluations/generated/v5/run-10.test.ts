import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

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

async function catchError(promise: Promise<unknown>): Promise<PaymentsApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentsApiError);
    return error as PaymentsApiError;
  }
  throw new Error("Expected the call to reject with PaymentsApiError, but it resolved");
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await catchError(promise);
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
  return error;
}

const newPayment = (overrides: Partial<{ amount: number; source: string }> = {}) =>
  client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa", ...overrides });

describe("createPayment", () => {
  test("creates a succeeded payment with the submitted values", async () => {
    const payment = await newPayment({ amount: 2500 });

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for the tok_pending source", async () => {
    const payment = await newPayment({ source: "tok_pending" });
    expect(payment.status).toBe("pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await newPayment();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const error = await expectApiError(
      newPayment({ source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
    expect(error.message).toBe("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    const error = await expectApiError(
      newPayment({ source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
    expect(error.message).toBe("The card has insufficient funds");
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    const error = await expectApiError(
      newPayment({ source: "tok_serverError" }),
      500,
      "processing_error",
    );
    expect(error.message).toBe("An error occurred while processing the payment");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(newPayment({ source: "tok_bogus" }), 400, "invalid_source");
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(newPayment({ amount }), 400, "invalid_request");
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(newPayment({ source: "tok_chargeDeclined" }), 402, "card_declined");
    expect(await client.listPayments()).toEqual([]);
  });

  test("rejects a wrong API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    const error = await expectApiError(
      bad.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
    expect(error.message).toBe("Missing or invalid API key");
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await newPayment({ amount: 777 });
    const fetched = await client.getPayment(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.amount).toBe(777);
    expect(fetched.status).toBe("succeeded");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("url-encodes the id in the request path", async () => {
    let requestedUrl = "";
    server.use(
      http.get(`${BASE_URL}/payments/:id`, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ error: { code: "payment_not_found", message: "nope" } }, { status: 404 });
      }),
    );

    await expectApiError(client.getPayment("a/b c"), 404, "payment_not_found");
    expect(requestedUrl).toBe(`${BASE_URL}/payments/a%2Fb%20c`);
  });

  test("rejects a wrong API key with 401 unauthorized", async () => {
    const created = await newPayment();
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await newPayment();
    const b = await newPayment({ source: "tok_pending" });

    const list = await client.listPayments();
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await newPayment();
    const pending = await newPayment({ source: "tok_pending" });

    const onlyPending = await client.listPayments({ status: "pending" });
    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);

    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await newPayment();
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects a wrong API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await newPayment({ amount: 1000 });
    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds when an amount below the total is given", async () => {
    const created = await newPayment({ amount: 1000 });
    const refunded = await client.refundPayment(created.id, { amount: 300 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(300);
  });

  test("accumulates partial refunds and ends as refunded", async () => {
    const created = await newPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });

    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("refunds only the remainder when no amount follows a partial refund", async () => {
    const created = await newPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 250 });
    const rest = await client.refundPayment(created.id);

    expect(rest.status).toBe("refunded");
    expect(rest.amountRefunded).toBe(1000);
  });

  test("persists the refund so a later get reflects it", async () => {
    const created = await newPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 100 });

    const fetched = await client.getPayment(created.id);
    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(100);
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await newPayment();
    await client.refundPayment(created.id);

    const error = await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
    );
    expect(error.message).toBe("Payment already refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await newPayment({ source: "tok_pending" });
    const error = await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await newPayment({ source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await newPayment({ amount: 1000 });
    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 1000");
  });

  test("bounds a second refund by what remains", async () => {
    const created = await newPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 800 });

    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 201 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 200");
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await newPayment({ amount: 1000 });
    await expectApiError(client.refundPayment(created.id, { amount }), 422, "invalid_refund_amount");
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await newPayment({ amount: 1000 });
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    const fetched = await client.getPayment(created.id);
    expect(fetched.status).toBe("succeeded");
    expect(fetched.amountRefunded).toBe(0);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a wrong API key with 401 unauthorized", async () => {
    const created = await newPayment();
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment({ source: "tok_pending" });
    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await newPayment();
    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await newPayment({ source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a wrong API key with 401 unauthorized", async () => {
    const created = await newPayment({ source: "tok_pending" });
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.cancelPayment(created.id), 401, "unauthorized");
  });
});

describe("request and error handling", () => {
  test("sends the bearer token and JSON content type on POST", async () => {
    let headers: Headers | undefined;
    let body: unknown;
    server.use(
      http.post(`${BASE_URL}/payments`, async ({ request }) => {
        headers = request.headers;
        body = await request.json();
        return HttpResponse.json({ id: "pay_x" }, { status: 201 });
      }),
    );

    await newPayment({ amount: 42 });

    expect(headers?.get("Authorization")).toBe("Bearer test_key");
    expect(headers?.get("Content-Type")).toBe("application/json");
    expect(body).toEqual({ amount: 42, currency: "usd", source: "tok_visa" });
  });

  test("sends no body or content type on GET", async () => {
    let contentType: string | null = "unset";
    server.use(
      http.get(`${BASE_URL}/payments`, ({ request }) => {
        contentType = request.headers.get("Content-Type");
        return HttpResponse.json({ data: [] });
      }),
    );

    await client.listPayments();
    expect(contentType).toBeNull();
  });

  test("passes the status filter as a query parameter", async () => {
    let search = "";
    server.use(
      http.get(`${BASE_URL}/payments`, ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json({ data: [] });
      }),
    );

    await client.listPayments({ status: "partially_refunded" });
    expect(search).toBe("?status=partially_refunded");
  });

  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://payments.internal.test/api/payments", () =>
        HttpResponse.json({ data: [] }),
      ),
    );
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://payments.internal.test/api",
    });

    expect(await custom.listPayments()).toEqual([]);
  });

  test("falls back to unknown_error and statusText when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("<html>Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    const error = await expectApiError(client.getPayment("pay_1"), 502, "unknown_error");
    expect(error.message).toBe("Bad Gateway");
  });

  test("falls back to unknown_error when the JSON error body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () => HttpResponse.json({ oops: true }, { status: 503 })),
    );

    await expectApiError(client.getPayment("pay_1"), 503, "unknown_error");
  });

  test("sets name and instanceof on thrown errors", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PaymentsApiError");
  });
});
