/*
 * The wording of the public privacy policy (/privacy). Every statement describes what the code does today, so a
 * change to what the site collects, or to where it sends it, must change this text too. It is kept apart from the
 * page so the node tests can load it: the Kannada in i18n-kn.ts is keyed by this exact English, so an edited
 * sentence needs its Kannada edited with it (tests/i18n.test.ts fails otherwise).
 */
import { LEGAL_NAME } from "./seo.ts";

export type PolicyItem = { lead?: string; text: string };
export type PolicyLink = { label: string; href: string };
export type PolicySection = {
  heading: string;
  intro?: string[];
  items?: PolicyItem[];
  outro?: string[];
  links?: PolicyLink[];
};

export const POLICY_TITLE = "Privacy Policy";
export const POLICY_UPDATED = "Last updated: 3 November 2026";
export const POLICY_INTRO =
  "This page explains what information Grain Bazar collects when you use grainbazar.com, why we collect it, who it goes to, and the choices you have.";

const WHO_WE_ARE: PolicySection = {
  heading: "Who we are",
  intro: [`Grain Bazar is the online store of ${LEGAL_NAME}, Shami House, Industrial Estate, Belagavi, Karnataka 590010.`],
};

const WHAT_WE_COLLECT: PolicySection = {
  heading: "What we collect",
  items: [
    { lead: "Your account", text: "Your name, email address and mobile number." },
    { lead: "Sign-in codes", text: "A one-time code is sent to your email or mobile number when you register or sign in with a code." },
    { lead: "Delivery addresses", text: "The name, phone number, address, landmark, city, state and PIN code you save." },
    {
      lead: "Orders",
      text: "What you buy, the amounts, delivery or pickup, any coupon, the order status, invoices and return requests.",
    },
    { lead: "Company details", text: "The company name and GSTIN you enter if you want a business invoice." },
    {
      lead: "Payments",
      text: "We do not take card details, UPI PINs or bank logins on this site. You pay from your own UPI app or by bank transfer. We keep the amount and the payment reference number (UTR), and we compare them with the money-received messages from our bank, which may also show the payer's name or UPI ID.",
    },
    {
      lead: "Reviews",
      text: "The rating, title and text of a review you write. Once published, these and the date appear on the product page for anyone to read. Other shoppers see the writer as “Customer”, not your name.",
    },
    {
      lead: "Enquiries",
      text: "Your name, email, phone number and message when you use the Contact form, ask us to serve your area or ask to become a channel partner, with any PIN code and area you give.",
    },
    { lead: "Your location", text: "Only if you tap “Use my current location”. The next section explains this." },
    {
      lead: "A phone contact",
      text: "Only if you tap “Pick from contacts”, where your phone offers it: the name and number of the one contact you choose. Nothing else in your phone book is read.",
    },
    {
      lead: "Visit logs",
      text: "Our hosting company logs each request to the site: the IP address, the page asked for, the time, the browser and the approximate country.",
    },
  ],
};

const YOUR_LOCATION: PolicySection = {
  heading: "Your location",
  intro: [
    "We read your location only when you tap “Use my current location”, and your browser asks your permission first. You can always type your address or PIN code instead.",
    "The position goes to our server, which asks OpenStreetMap's Nominatim service, and BigDataCloud when needed, for the nearest postal address. Only the map position is sent to them, not your name or phone number.",
    "When you are adding a delivery address, the position and its accuracy are saved with that address, and our admin team can open them. They are not copied into your order or sent to Zoho. When you are only choosing a PIN code, the position is not saved: only the PIN code is kept, in your browser.",
  ],
};

const WHY_WE_USE_IT: PolicySection = {
  heading: "Why we use it",
  items: [
    { text: "To create your account and sign you in." },
    { text: "To show the products, prices and delivery options of the godown that serves your PIN code." },
    { text: "To take, deliver and invoice your orders, and to match your payments." },
    { text: "To answer your enquiries and requests." },
    { text: "To keep business and tax records, including GST invoices." },
    { text: "To keep the site working and secure, and to fix problems." },
  ],
};

const WHO_CAN_SEE_IT: PolicySection = {
  heading: "Who can see it and where it goes",
  intro: ["These people and companies receive your information so that the store can run:"],
  items: [
    { lead: "Our team", text: "Admin staff can see customer accounts, addresses, orders, payments and enquiries." },
    {
      lead: "Godown partners and vendors",
      text: "The channel partner who runs the godown handling your order can see your name, PIN code, what you bought and the amounts. A vendor whose goods are in your order can open that order, including your contact details and delivery address.",
    },
    {
      lead: "Supabase",
      text: "Our database, sign-in system and file storage. Your account, addresses, orders and enquiries are stored there, on servers in Japan. Email sign-in codes are sent through Supabase and the email service connected to it.",
    },
    {
      lead: "Zoho",
      text: "Our accounting and stock system (Zoho Books and its related tools). It receives your name, company, email, phone number, address and GSTIN, and what you ordered, the amounts and the payments, so that we can raise sales orders and invoices.",
    },
    { lead: "Fast2SMS", text: "Your mobile number and the one-time code, when you sign in by phone." },
    { lead: "Hostinger", text: "Runs the website and keeps the visit logs." },
    { lead: "OpenStreetMap Nominatim and BigDataCloud", text: "The map position, as explained above." },
    {
      lead: "Google Fonts",
      text: "Our pages load their lettering from Google, so Google can see your IP address and browser details when a page opens.",
    },
  ],
  outro: [
    "Some of these companies may store or handle information outside India.",
    "We may also share information when the law requires it.",
    "Buttons for WhatsApp, Google Maps, Instagram, YouTube, Facebook and UPI apps open those services, and their own privacy rules apply there. A WhatsApp button may fill in a message with your details for you to check and send.",
  ],
};

const COOKIES_AND_STORAGE: PolicySection = {
  heading: "Cookies and browser storage",
  intro: ["The store's own pages do not set cookies. They use your browser's storage to remember these things on your device:"],
  items: [
    { text: "That you are signed in." },
    { text: "Your cart and wishlist." },
    { text: "Your language and PIN code." },
    { text: "Saved copies of the catalogue, banners and site theme, so that pages open faster." },
  ],
  outro: ["You can clear this in your browser settings. You will then be signed out and your cart will be empty."],
};

/** Shown only in a build where the Google Analytics tag can run (see privacyPolicySections). */
const GOOGLE_ANALYTICS: PolicySection = {
  heading: "Google Analytics and its cookies",
  intro: [
    "We use Google Analytics to count how many people visit and which pages they open.",
    "It sets cookies in your browser (_ga, and _ga_ followed by a code). They hold a random number that tells one visitor from another. By Google's default they last up to 2 years, and some browsers remove them sooner.",
  ],
  items: [
    {
      lead: "What is sent to Google",
      text: "The page address without anything you typed or searched, the page you came from, the page title, and the device and browser details Google Analytics collects by itself. Campaign tags in a link (such as utm_source) are kept, because they show where a visit came from.",
    },
    {
      lead: "Your IP address",
      text: "Google receives it when your browser contacts Google. Google says it uses it for a rough location and to filter spam, and that Google Analytics does not store it.",
    },
    { lead: "What is not sent", text: "Your name, phone number, email, address, order numbers, or anything you type in a form." },
    {
      lead: "Pages not counted",
      text: "The admin, vendor, partner and staff panels, your account pages and the password reset page. A browser that has opened one of those panels is not counted on any page. Nothing is sent while a page shows a link that holds your details, such as the enquiry receipt.",
    },
    { lead: "Pages counted", text: "All other pages, including the cart, checkout and sign-in pages, are counted as visits only." },
    { lead: "Advertising", text: "Google signals and ad personalisation are switched off." },
  ],
  outro: ["Google explains how it handles this information on the page below. To stop Google Analytics, use Google's opt-out add-on or block cookies in your browser."],
  links: [
    {
      label: "How Google uses information from sites or apps that use our services",
      href: "https://policies.google.com/technologies/partner-sites",
    },
    { label: "Google Analytics opt-out browser add-on", href: "https://tools.google.com/dlpage/gaoptout" },
  ],
};

const PEOPLE_WHO_WORK_WITH_US: PolicySection = {
  heading: "Vendors, channel partners and godown staff",
  intro: ["If you work with us through one of our panels, we also keep:"],
  items: [
    {
      lead: "Godown staff",
      text: "Your name, mobile number, designation and godown, your attendance records, including the selfie, GPS position and device code taken at check-in, check-out and presence checks, and your leave requests with their reasons. Admins and your godown's partner can see them. Selfies are kept in private storage.",
    },
    {
      lead: "Vendors",
      text: "Your business details, and the GST certificate, PAN card and bank account proof you upload for verification, which are kept in private storage.",
    },
    { lead: "Channel partners", text: "Your contact details, your godown, its sales and your commission." },
  ],
};

const HOW_LONG: PolicySection = {
  heading: "How long we keep it",
  intro: [
    "The site does not delete your account, addresses, orders or enquiries automatically. Some records, such as invoices and tax records, may have to be kept even after you ask us to delete them, because the law requires it.",
  ],
};

const YOUR_CHOICES: PolicySection = {
  heading: "Your choices",
  items: [
    { text: "You can see and change your details under My Profile and Saved Addresses in your account at any time, and delete an address." },
    { text: "You can say no to the location and contacts permissions and type the details instead." },
    {
      text: "To ask for a copy of your information, to correct or delete it, or to withdraw a permission you gave, contact us using the details below. The site has no button for closing an account, so we handle these requests ourselves.",
    },
  ],
};

const KEEPING_IT_SAFE: PolicySection = {
  heading: "Keeping it safe",
  intro: [
    "The site uses a secure (https) connection. Sign-in and role rules decide who can open each record. No online system is completely safe, so please do not share your sign-in codes with anyone.",
  ],
};

const CHANGES: PolicySection = {
  heading: "Changes to this policy",
  intro: ["If we change this policy, we will update this page and the date at the top."],
};

const CONTACT_US: PolicySection = {
  heading: "Contact us",
  intro: ["For any privacy question or request, use our Contact page, or call or WhatsApp us on +91 95385 00840 (Mon–Sat, 9am–7pm)."],
  links: [
    { label: "Open the Contact page", href: "/contact" },
    { label: "Call +91 95385 00840", href: "tel:+919538500840" },
    { label: "WhatsApp +91 95385 00840", href: "https://wa.me/919538500840" },
  ],
};

/**
 * The policy in reading order. The Google Analytics section is left out until the tag can run, so the page never
 * describes a tag the site doesn't have.
 */
export function privacyPolicySections(analyticsOn: boolean): PolicySection[] {
  return [
    WHO_WE_ARE,
    WHAT_WE_COLLECT,
    YOUR_LOCATION,
    WHY_WE_USE_IT,
    WHO_CAN_SEE_IT,
    COOKIES_AND_STORAGE,
    ...(analyticsOn ? [GOOGLE_ANALYTICS] : []),
    PEOPLE_WHO_WORK_WITH_US,
    HOW_LONG,
    YOUR_CHOICES,
    KEEPING_IT_SAFE,
    CHANGES,
    CONTACT_US,
  ];
}

/** Every piece of text the page can show (each needs its Kannada in i18n-kn.ts). */
export function privacyPolicyText(): string[] {
  const parts = privacyPolicySections(true).flatMap((section) => [
    section.heading,
    ...(section.intro ?? []),
    ...(section.items ?? []).flatMap((item) => [...(item.lead ? [item.lead] : []), item.text]),
    ...(section.outro ?? []),
    ...(section.links ?? []).map((link) => link.label),
  ]);
  return [...new Set([POLICY_TITLE, POLICY_UPDATED, POLICY_INTRO, ...parts])];
}
