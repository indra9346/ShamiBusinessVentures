// Ambient types for Deno runtime compatibility in non-Deno IDEs
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

// @ts-ignore - Deno URL import for Supabase Edge Functions
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface EnquiryRequestBody {
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = ((await req.json()) || {}) as EnquiryRequestBody;
    const name = (body.name || "").trim();
    const email = (body.email || "").trim();
    const phone = (body.phone || "").trim();
    const message = (body.message || "").trim();

    if (!name || !email || !message) {
      return new Response(
        JSON.stringify({ error: "Name, email, and message are required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const recipientEmail = "care@shamiventures.in";

    let emailSent = false;
    let emailResult: unknown = null;

    if (resendApiKey) {
      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
          <div style="border-bottom: 2px solid #b8860b; padding-bottom: 16px; margin-bottom: 24px;">
            <h1 style="color: #0b1a30; font-size: 22px; margin: 0; font-weight: 800;">New Wholesale & Supply Enquiry</h1>
            <p style="color: #64748b; font-size: 14px; margin: 6px 0 0 0;">Received via Shami Business Ventures website</p>
          </div>
          
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600; width: 140px;">Customer Name:</td>
              <td style="padding: 8px 0; color: #0b1a30; font-weight: bold;">${name}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Customer Email:</td>
              <td style="padding: 8px 0; color: #0b1a30;"><a href="mailto:${email}" style="color: #b8860b; text-decoration: none; font-weight: 600;">${email}</a></td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Contact Phone:</td>
              <td style="padding: 8px 0; color: #0b1a30;">${phone || "Not provided"}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b; font-weight: 600;">Submitted Time:</td>
              <td style="padding: 8px 0; color: #0b1a30;">${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST</td>
            </tr>
          </table>

          <div style="background: #f8fafc; border-left: 4px solid #b8860b; padding: 18px; border-radius: 6px; margin-bottom: 24px;">
            <p style="color: #64748b; font-size: 11px; text-transform: uppercase; margin: 0 0 8px 0; font-weight: bold; letter-spacing: 0.5px;">Message / Commodity Requirement</p>
            <p style="color: #1e293b; font-size: 15px; line-height: 1.6; margin: 0; white-space: pre-wrap;">${message}</p>
          </div>

          <div style="margin-top: 24px; padding-top: 16px;">
            <a href="mailto:${email}?subject=Re:%20Wholesale%20Enquiry%20-%20Shami%20Business%20Ventures" style="background: #0b1a30; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; display: inline-block;">Reply via Email</a>
            ${phone ? `<a href="https://wa.me/91${phone.replace(/\\D/g, '').slice(-10)}" style="background: #25D366; color: #ffffff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 600; display: inline-block; margin-left: 10px;">Chat on WhatsApp</a>` : ""}
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
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Shami Marketplace <orders@shamibusiness.in>",
          to: [recipientEmail],
          reply_to: email,
          subject: `New Wholesale Enquiry from ${name} [${phone || email}]`,
          html: emailHtml,
        }),
      });

      emailResult = await res.json();
      emailSent = res.ok;
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Enquiry received successfully and dispatched to care@shamiventures.in",
        emailSent,
        details: emailResult,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error processing enquiry";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
