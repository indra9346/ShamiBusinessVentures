// Ambient types for Deno runtime compatibility in non-Deno IDEs
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - Deno URL import for Supabase Edge Functions
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - Supabase Edge Functions resolve npm imports through Deno.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface EnquiryRequestBody {
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
  enquiry_id?: string;
  metadata?: Record<string, unknown>;
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char] ?? char,
  );

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let claimedClient: ReturnType<typeof createClient> | null = null;
  let claimedEnquiryId = "";
  try {
    const body = ((await req.json()) || {}) as EnquiryRequestBody;
    const enquiryId = (body.enquiry_id || "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(enquiryId)) {
      return new Response(JSON.stringify({ error: "A valid saved enquiry ID is required." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const recipientEmail = "care@shamiventures.in";
    if (!resendApiKey) {
      return new Response(
        JSON.stringify({
          success: false,
          emailSent: false,
          error: "Email delivery is not configured.",
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({
          success: false,
          emailSent: false,
          error: "Secure enquiry lookup is not configured.",
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
    const { data: enquiry, error: lookupError } = await adminClient
      .from("contact_enquiries")
      .select("id,name,email,phone,message,metadata,email_sent,email_delivery_status")
      .eq("id", enquiryId)
      .maybeSingle();
    if (lookupError || !enquiry) {
      return new Response(
        JSON.stringify({ success: false, emailSent: false, error: "Saved enquiry was not found." }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    if (enquiry.email_sent || enquiry.email_delivery_status === "sent") {
      return new Response(JSON.stringify({ success: true, emailSent: true, alreadySent: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const name = String(enquiry.name).trim();
    const email = String(enquiry.email).trim();
    const phone = String(enquiry.phone ?? "").trim();
    const message = String(enquiry.message).trim();
    if (
      name.length < 2 ||
      name.length > 100 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 255 ||
      message.length < 5 ||
      message.length > 1000 ||
      (phone && !/^[0-9+\s-]{8,15}$/.test(phone))
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          emailSent: false,
          error: "Saved enquiry data is invalid for email delivery.",
        }),
        {
          status: 422,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const { data: claimed, error: claimError } = await adminClient
      .from("contact_enquiries")
      .update({ email_delivery_status: "sending", updated_at: new Date().toISOString() })
      .eq("id", enquiryId)
      .eq("email_delivery_status", "pending")
      .select("id")
      .maybeSingle();
    if (claimError || !claimed) {
      return new Response(
        JSON.stringify({
          success: false,
          emailSent: false,
          error: "This enquiry is already being processed or needs admin follow-up.",
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    claimedClient = adminClient;
    claimedEnquiryId = enquiryId;

    {
      const safeName = escapeHtml(name);
      const safeEmail = escapeHtml(email);
      const safePhone = escapeHtml(phone || "Not provided");
      const safeMessage = escapeHtml(message);
      const safeMetadata = escapeHtml(JSON.stringify(enquiry.metadata ?? {}, null, 2));
      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
          <div style="border-bottom: 2px solid #b8860b; padding-bottom: 16px; margin-bottom: 24px;">
            <h1 style="color: #0b1a30; font-size: 22px; margin: 0; font-weight: 800;">New Wholesale & Supply Enquiry</h1>
            <p style="color: #64748b; font-size: 14px; margin: 6px 0 0 0;">Received via Shami Business Ventures website</p>
          </div>
          
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600; width: 140px;">Customer Name:</td>
              <td style="padding: 8px 0; color: #0b1a30; font-weight: bold;">${safeName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Customer Email:</td>
              <td style="padding: 8px 0; color: #0b1a30;"><a href="mailto:${safeEmail}" style="color: #b8860b; text-decoration: none; font-weight: 600;">${safeEmail}</a></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Contact Phone:</td>
              <td style="padding: 8px 0; color: #0b1a30;">${safePhone}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Submitted Time:</td>
              <td style="padding: 8px 0; color: #0b1a30;">${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</td>
            </tr>
          </table>

          <div style="background: #f8fafc; border-left: 4px solid #b8860b; padding: 18px; border-radius: 6px; margin-bottom: 24px;">
            <p style="color: #64748b; font-size: 11px; text-transform: uppercase; margin: 0 0 8px 0; font-weight: bold; letter-spacing: 0.5px;">Message / Commodity Requirement</p>
            <p style="color: #1e293b; font-size: 15px; line-height: 1.6; margin: 0; white-space: pre-wrap;">${safeMessage}</p>
          </div>
          <p>Request ID: ${escapeHtml(enquiryId)}</p>
          <pre style="white-space:pre-wrap">${safeMetadata}</pre>

          <div style="margin-top: 24px; padding-top: 16px;">
            <a href="mailto:${email}?subject=Re:%20Wholesale%20Enquiry%20-%20Shami%20Business%20Ventures" style="background: #0b1a30; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; display: inline-block;">Reply via Email</a>
            ${phone ? `<a href="https://wa.me/91${phone.replace(/\D/g, "").slice(-10)}" style="background: #25D366; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; display: inline-block; margin-left: 10px;">Chat on WhatsApp</a>` : ""}
          </div>

          <div style="margin-top: 32px; border-top: 1px solid #e2e8f0; padding-top: 16px; color: #94a3b8; font-size: 12px; line-height: 1.5;">
            <p style="margin: 0;"><strong>Shami Business Ventures Pvt. Ltd.</strong> · Industrial Estate, Belagavi, Karnataka 590010</p>
            <p style="margin: 4px 0 0 0;">Dedicated support line: care@shamiventures.in | +91 95385 00840</p>
          </div>
        </div>
      `;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Shami Marketplace <orders@shamibusiness.in>",
          to: [recipientEmail],
          reply_to: email,
          subject: `New Enquiry ${enquiryId} from ${name} [${phone || email}]`,
          html: emailHtml,
        }),
      });

      const emailResult = await res.json();
      if (!res.ok) {
        await adminClient
          .from("contact_enquiries")
          .update({ email_delivery_status: "failed", updated_at: new Date().toISOString() })
          .eq("id", enquiryId);
        return new Response(
          JSON.stringify({
            success: false,
            emailSent: false,
            error: "Email provider rejected the message.",
          }),
          {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      const { error: updateError } = await adminClient
        .from("contact_enquiries")
        .update({
          email_sent: true,
          email_delivery_status: "sent",
          updated_at: new Date().toISOString(),
        })
        .eq("id", enquiryId);
      const emailStatusRecorded = !updateError;
      if (updateError)
        console.error(
          "Email sent but enquiry email status could not be saved:",
          updateError.message,
        );

      return new Response(
        JSON.stringify({
          success: true,
          emailSent: true,
          emailStatusRecorded,
          messageId: emailResult?.id,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error processing enquiry";
    console.error("Could not process enquiry email:", errorMessage);
    if (claimedClient && claimedEnquiryId) {
      await claimedClient
        .from("contact_enquiries")
        .update({ email_delivery_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", claimedEnquiryId)
        .eq("email_delivery_status", "sending");
    }
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
