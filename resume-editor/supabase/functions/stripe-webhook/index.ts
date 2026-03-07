import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import Stripe from "npm:stripe@18.0.0";

const FUNCTION_NAME = "stripe-webhook";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SubscriptionStatus = "none" | "active" | "trialing" | "past_due" | "canceled";

class HttpError extends Error {
  code: string;
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function getEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new HttpError(500, "MISSING_ENV", `Missing environment variable: ${name}`);
  }
  return value;
}

function getStripeCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string {
  if (!customer) {
    return "";
  }

  if (typeof customer === "string") {
    return customer.trim();
  }

  return typeof customer.id === "string" ? customer.id.trim() : "";
}

function mapStripeSubscriptionStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  if (status === "active") {
    return "active";
  }

  if (status === "trialing") {
    return "trialing";
  }

  if (status === "past_due" || status === "unpaid" || status === "incomplete" || status === "incomplete_expired") {
    return "past_due";
  }

  if (status === "canceled") {
    return "canceled";
  }

  return "none";
}

function toIsoFromUnixSeconds(unixSeconds: number | null | undefined): string | null {
  if (!unixSeconds || unixSeconds <= 0) {
    return null;
  }
  return new Date(unixSeconds * 1000).toISOString();
}

async function findUserIdByStripeCustomerId(
  adminClient: ReturnType<typeof createClient>,
  stripeCustomerId: string,
): Promise<string> {
  const { data, error } = await adminClient
    .from("billing_customers")
    .select("user_id")
    .eq("stripe_customer_id", stripeCustomerId)
    .maybeSingle();

  if (error) {
    throw new HttpError(500, "BILLING_CUSTOMER_LOOKUP_FAILED", error.message);
  }

  return typeof data?.user_id === "string" ? data.user_id.trim() : "";
}

async function setBillingCustomer(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  stripeCustomerId: string,
) {
  const { error } = await adminClient.rpc("set_billing_customer", {
    p_user_id: userId,
    p_stripe_customer_id: stripeCustomerId,
  });

  if (error) {
    throw new HttpError(500, "SET_BILLING_CUSTOMER_FAILED", error.message);
  }
}

async function setEntitlementSubscription(
  adminClient: ReturnType<typeof createClient>,
  input: {
    userId: string;
    status: SubscriptionStatus;
    currentPeriodEnd: string | null;
    plan: "free" | "pro";
    stripeEventId: string;
  },
) {
  const { error } = await adminClient.rpc("set_entitlement_subscription", {
    p_user_id: input.userId,
    p_subscription_status: input.status,
    p_subscription_current_period_end: input.currentPeriodEnd,
    p_plan: input.plan,
    p_stripe_event_id: input.stripeEventId,
  });

  if (error) {
    throw new HttpError(500, "SET_ENTITLEMENT_SUBSCRIPTION_FAILED", error.message);
  }
}

async function setUserPlan(
  adminClient: ReturnType<typeof createClient>,
  userId: string,
  plan: "free" | "pro",
) {
  const { error } = await adminClient.rpc("set_user_plan", {
    p_user_id: userId,
    p_plan: plan,
  });

  if (error) {
    throw new HttpError(500, "SET_USER_PLAN_FAILED", error.message);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST.");
    }

    const supabaseUrl = getEnv("SUPABASE_URL");
    const serviceRoleKey = getEnv("SUPABASE_SERVICE_ROLE_KEY");
    const stripeSecretKey = getEnv("STRIPE_SECRET_KEY");
    const stripeWebhookSecret = getEnv("STRIPE_WEBHOOK_SECRET");
    const signature = req.headers.get("stripe-signature");

    if (!signature) {
      throw new HttpError(400, "MISSING_STRIPE_SIGNATURE", "Missing Stripe signature header.");
    }

    const rawBody = await req.text();
    const stripe = new Stripe(stripeSecretKey);

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, stripeWebhookSecret);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid webhook signature.";
      throw new HttpError(400, "INVALID_STRIPE_SIGNATURE", message);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const stripeCustomerId = getStripeCustomerId(session.customer);
      const metadataUserId = typeof session.metadata?.user_id === "string" ? session.metadata.user_id.trim() : "";
      const userId = metadataUserId || (typeof session.client_reference_id === "string" ? session.client_reference_id.trim() : "");

      if (!stripeCustomerId || !userId) {
        throw new HttpError(400, "CHECKOUT_SESSION_MISSING_MAPPING", "Missing user_id or stripe customer id.");
      }

      await setBillingCustomer(adminClient, userId, stripeCustomerId);

      if (session.mode === "subscription" && session.subscription) {
        const subscriptionId =
          typeof session.subscription === "string" ? session.subscription : session.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const mappedStatus = mapStripeSubscriptionStatus(subscription.status);

        await setEntitlementSubscription(adminClient, {
          userId,
          status: mappedStatus,
          currentPeriodEnd: toIsoFromUnixSeconds(subscription.current_period_end),
          plan: mappedStatus === "canceled" || mappedStatus === "none" ? "free" : "pro",
          stripeEventId: event.id,
        });
        await setUserPlan(adminClient, userId, mappedStatus === "canceled" || mappedStatus === "none" ? "free" : "pro");
      }
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object as Stripe.Subscription;
      const stripeCustomerId = getStripeCustomerId(subscription.customer);

      if (!stripeCustomerId) {
        throw new HttpError(400, "SUBSCRIPTION_MISSING_CUSTOMER", "Subscription event missing customer id.");
      }

      let userId = await findUserIdByStripeCustomerId(adminClient, stripeCustomerId);
      if (!userId) {
        const metadataUserId = typeof subscription.metadata?.user_id === "string" ? subscription.metadata.user_id.trim() : "";
        if (metadataUserId) {
          await setBillingCustomer(adminClient, metadataUserId, stripeCustomerId);
          userId = metadataUserId;
        }
      }

      if (!userId) {
        throw new HttpError(404, "BILLING_CUSTOMER_NOT_FOUND", "Could not map Stripe customer to user.");
      }

      const mappedStatus = mapStripeSubscriptionStatus(subscription.status);
      await setEntitlementSubscription(adminClient, {
        userId,
        status: mappedStatus,
        currentPeriodEnd: toIsoFromUnixSeconds(subscription.current_period_end),
        plan: mappedStatus === "canceled" || mappedStatus === "none" ? "free" : "pro",
        stripeEventId: event.id,
      });
      await setUserPlan(adminClient, userId, mappedStatus === "canceled" || mappedStatus === "none" ? "free" : "pro");
    }

    return jsonResponse({ received: true, event_type: event.type, function: FUNCTION_NAME }, 200);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : "UNEXPECTED_ERROR";
    const message = error instanceof HttpError ? error.message : "Unexpected function error.";

    return jsonResponse({ error_code: code, error_message: message, function: FUNCTION_NAME }, status);
  }
});
