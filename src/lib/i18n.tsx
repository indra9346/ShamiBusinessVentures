import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type Language = "en" | "kn";

const STORAGE_KEY = "sbv-language";

const exact: Record<string, string> = {
  Home: "ಮುಖಪುಟ",
  Shop: "ಖರೀದಿ",
  Categories: "ವರ್ಗಗಳು",
  Offers: "ಕೊಡುಗೆಗಳು",
  About: "ನಮ್ಮ ಬಗ್ಗೆ",
  Contact: "ಸಂಪರ್ಕ",
  Login: "ಲಾಗಿನ್",
  Logout: "ಲಾಗ್ ಔಟ್",
  Cart: "ಕಾರ್ಟ್",
  Wishlist: "ಇಷ್ಟಪಟ್ಟವು",
  Search: "ಹುಡುಕಿ",
  "Search…": "ಹುಡುಕಿ…",
  "Search products…": "ಉತ್ಪನ್ನಗಳನ್ನು ಹುಡುಕಿ…",
  "Search S1 sugar, SKU or vendor…": "S1 ಸಕ್ಕರೆ, SKU ಅಥವಾ ಮಾರಾಟಗಾರರನ್ನು ಹುಡುಕಿ…",
  "Vendor Panel": "ಮಾರಾಟಗಾರರ ವಿಭಾಗ",
  "Admin Panel": "ನಿರ್ವಾಹಕರ ವಿಭಾಗ",
  "Customer panel": "ಗ್ರಾಹಕರ ವಿಭಾಗ",
  "Vendor panel": "ಮಾರಾಟಗಾರರ ವಿಭಾಗ",
  "Admin panel": "ನಿರ್ವಾಹಕರ ವಿಭಾಗ",
  "Open menu": "ಮೆನು ತೆರೆಯಿರಿ",
  "Close menu": "ಮೆನು ಮುಚ್ಚಿರಿ",
  Close: "ಮುಚ್ಚಿರಿ",
  Notifications: "ಸೂಚನೆಗಳು",
  Dashboard: "ಡ್ಯಾಶ್‌ಬೋರ್ಡ್",
  Products: "ಉತ್ಪನ್ನಗಳು",
  "Add Product": "ಉತ್ಪನ್ನ ಸೇರಿಸಿ",
  Orders: "ಆರ್ಡರ್‌ಗಳು",
  Inventory: "ದಾಸ್ತಾನು",
  Earnings: "ಆದಾಯ",
  Payouts: "ಪಾವತಿಗಳು",
  Reviews: "ವಿಮರ್ಶೆಗಳು",
  Profile: "ಪ್ರೊಫೈಲ್",
  Settings: "ಸೆಟ್ಟಿಂಗ್‌ಗಳು",
  Vendors: "ಮಾರಾಟಗಾರರು",
  Customers: "ಗ್ರಾಹಕರು",
  Payments: "ಪಾವತಿಗಳು",
  Commissions: "ಕಮಿಷನ್‌ಗಳು",
  Coupons: "ಕೂಪನ್‌ಗಳು",
  Deliveries: "ಡೆಲಿವರಿಗಳು",
  Reports: "ವರದಿಗಳು",
  "Website CMS": "ವೆಬ್‌ಸೈಟ್ ನಿರ್ವಹಣೆ",
  Integrations: "ಸಂಯೋಜನೆಗಳು",
  "My Profile": "ನನ್ನ ಪ್ರೊಫೈಲ್",
  "My Orders": "ನನ್ನ ಆರ್ಡರ್‌ಗಳು",
  "Track Orders": "ಆರ್ಡರ್‌ಗಳನ್ನು ಟ್ರ್ಯಾಕ್ ಮಾಡಿ",
  "Saved Addresses": "ಉಳಿಸಿದ ವಿಳಾಸಗಳು",
  "Reviews & Ratings": "ವಿಮರ್ಶೆಗಳು ಮತ್ತು ರೇಟಿಂಗ್‌ಗಳು",
  Invoices: "ಇನ್‌ವಾಯ್ಸ್‌ಗಳು",
  "Account Settings": "ಖಾತೆ ಸೆಟ್ಟಿಂಗ್‌ಗಳು",
  "Page not found": "ಪುಟ ಕಂಡುಬಂದಿಲ್ಲ",
  "The page you're looking for doesn't exist or has been moved.": "ನೀವು ಹುಡುಕುತ್ತಿರುವ ಪುಟ ಇಲ್ಲ ಅಥವಾ ಸ್ಥಳಾಂತರಿಸಲಾಗಿದೆ.",
  "Go home": "ಮುಖಪುಟಕ್ಕೆ ಹೋಗಿ",
  "This page didn't load": "ಈ ಪುಟ ಲೋಡ್ ಆಗಲಿಲ್ಲ",
  "Something went wrong on our end. You can try refreshing or head back home.": "ತಾಂತ್ರಿಕ ತೊಂದರೆ ಉಂಟಾಗಿದೆ. ಪುಟವನ್ನು ಮತ್ತೆ ತೆರೆಯಿರಿ ಅಥವಾ ಮುಖಪುಟಕ್ಕೆ ಹೋಗಿ.",
  "Try again": "ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ",
  "A premium, trustworthy business marketplace": "ವಿಶ್ವಾಸಾರ್ಹ ಪ್ರೀಮಿಯಂ ವ್ಯಾಪಾರ ಮಾರುಕಟ್ಟೆ",
  "Mill-direct sugar and essentials, verified vendors, and complete order visibility for customers, vendors and administrators.": "ಮಿಲ್‌ನಿಂದ ನೇರ ಸಕ್ಕರೆ ಮತ್ತು ಅಗತ್ಯ ವಸ್ತುಗಳು, ಪರಿಶೀಲಿತ ಮಾರಾಟಗಾರರು ಮತ್ತು ಸಂಪೂರ್ಣ ಆರ್ಡರ್ ಮಾಹಿತಿ.",
  "Customer Login": "ಗ್ರಾಹಕ ಲಾಗಿನ್",
  "Vendor Login": "ಮಾರಾಟಗಾರ ಲಾಗಿನ್",
  "Admin Login": "ನಿರ್ವಾಹಕ ಲಾಗಿನ್",
  "Vendor login": "ಮಾರಾಟಗಾರ ಲಾಗಿನ್",
  "Admin login": "ನಿರ್ವಾಹಕ ಲಾಗಿನ್",
  "Create Account": "ಖಾತೆ ರಚಿಸಿ",
  "Create an account": "ಖಾತೆ ರಚಿಸಿ",
  "Sign in": "ಲಾಗಿನ್ ಆಗಿ",
  "New to Shami?": "Shami ಗೆ ಹೊಸಬರೇ?",
  "Already registered?": "ಈಗಾಗಲೇ ನೋಂದಾಯಿಸಿದ್ದೀರಾ?",
  "Vendor?": "ಮಾರಾಟಗಾರರೇ?",
  "Admin?": "ನಿರ್ವಾಹಕರೇ?",
  "Verify your email or mobile number with a one-time code to sign in": "ಲಾಗಿನ್ ಆಗಲು ನಿಮ್ಮ ಇಮೇಲ್ ಅಥವಾ ಮೊಬೈಲ್ ಸಂಖ್ಯೆಯನ್ನು ಒಂದು ಬಾರಿಯ ಕೋಡ್ ಮೂಲಕ ಪರಿಶೀಲಿಸಿ",
  "Verify your administrator email or mobile number with a one-time code": "ನಿರ್ವಾಹಕರ ಇಮೇಲ್ ಅಥವಾ ಮೊಬೈಲ್ ಸಂಖ್ಯೆಯನ್ನು ಒಂದು ಬಾರಿಯ ಕೋಡ್ ಮೂಲಕ ಪರಿಶೀಲಿಸಿ",
  "Order from verified vendors with GST invoicing": "GST ಇನ್‌ವಾಯ್ಸ್‌ನೊಂದಿಗೆ ಪರಿಶೀಲಿತ ಮಾರಾಟಗಾರರಿಂದ ಆರ್ಡರ್ ಮಾಡಿ",
  "Verify & Sign In": "ಪರಿಶೀಲಿಸಿ ಮತ್ತು ಲಾಗಿನ್ ಆಗಿ",
  "Verify & Enter Admin Panel": "ಪರಿಶೀಲಿಸಿ ಮತ್ತು ನಿರ್ವಾಹಕ ವಿಭಾಗಕ್ಕೆ ಪ್ರವೇಶಿಸಿ",
  "Admin email": "ನಿರ್ವಾಹಕ ಇಮೇಲ್",
  Password: "ಪಾಸ್‌ವರ್ಡ್",
  "Email OTP": "ಇಮೇಲ್ OTP",
  "Phone OTP": "ಫೋನ್ OTP",
  Email: "ಇಮೇಲ್",
  "Mobile number": "ಮೊಬೈಲ್ ಸಂಖ್ಯೆ",
  "Send OTP": "OTP ಕಳುಹಿಸಿ",
  "Sending code…": "ಕೋಡ್ ಕಳುಹಿಸಲಾಗುತ್ತಿದೆ…",
  "A 6-digit code will be sent by SMS to this mobile number.": "ಈ ಮೊಬೈಲ್ ಸಂಖ್ಯೆಗೆ SMS ಮೂಲಕ 6 ಅಂಕಿಯ ಕೋಡ್ ಕಳುಹಿಸಲಾಗುತ್ತದೆ.",
  "A 6-digit verification code will be emailed to this address.": "ಈ ವಿಳಾಸಕ್ಕೆ ಇಮೇಲ್ ಮೂಲಕ 6 ಅಂಕಿಯ ಪರಿಶೀಲನಾ ಕೋಡ್ ಕಳುಹಿಸಲಾಗುತ್ತದೆ.",
  "Verification code (OTP)": "ಪರಿಶೀಲನಾ ಕೋಡ್ (OTP)",
  "Code expired — request a new one.": "ಕೋಡ್ ಅವಧಿ ಮುಗಿದಿದೆ — ಹೊಸ ಕೋಡ್ ಕೇಳಿ.",
  "Change number": "ಸಂಖ್ಯೆ ಬದಲಿಸಿ",
  "Change email": "ಇಮೇಲ್ ಬದಲಿಸಿ",
  "Resend code": "ಕೋಡ್ ಮತ್ತೆ ಕಳುಹಿಸಿ",
  "Your trusted source for quality products": "ಉತ್ತಮ ಗುಣಮಟ್ಟದ ಉತ್ಪನ್ನಗಳಿಗೆ ನಿಮ್ಮ ವಿಶ್ವಾಸಾರ್ಹ ತಾಣ",
  "Quality products you need, all in one place": "ನಿಮಗೆ ಬೇಕಾದ ಉತ್ತಮ ಗುಣಮಟ್ಟದ ಉತ್ಪನ್ನಗಳು ಒಂದೇ ಸ್ಥಳದಲ್ಲಿ",
  "Find and buy rice, sugar and oil products with ease.": "ಅಕ್ಕಿ, ಸಕ್ಕರೆ ಮತ್ತು ಎಣ್ಣೆ ಉತ್ಪನ್ನಗಳನ್ನು ಸುಲಭವಾಗಿ ಹುಡುಕಿ ಮತ್ತು ಖರೀದಿಸಿ.",
  "Find the product you need": "ನಿಮಗೆ ಬೇಕಾದ ಉತ್ಪನ್ನವನ್ನು ಹುಡುಕಿ",
  "Search products": "ಉತ್ಪನ್ನಗಳನ್ನು ಹುಡುಕಿ",
  "Shop now": "ಈಗ ಖರೀದಿಸಿ",
  "Verified sellers": "ಪರಿಶೀಲಿಸಿದ ಮಾರಾಟಗಾರರು",
  "Quality assured": "ಉತ್ತಮ ಗುಣಮಟ್ಟ",
  "Delivery across India": "ಭಾರತದಾದ್ಯಂತ ಡೆಲಿವರಿ",
  "Choose with ease": "ಸುಲಭವಾಗಿ ಆಯ್ಕೆ ಮಾಡಿ",
  "Shop by Category": "ವರ್ಗದ ಮೂಲಕ ಖರೀದಿ",
  "Search category, product, code or brand": "ವರ್ಗ, ಉತ್ಪನ್ನ, ಕೋಡ್ ಅಥವಾ ಬ್ರಾಂಡ್ ಹುಡುಕಿ",
  "View all": "ಎಲ್ಲವನ್ನೂ ನೋಡಿ",
  View: "ನೋಡಿ",
  "Picked for you": "ನಿಮಗಾಗಿ ಆಯ್ಕೆ ಮಾಡಲಾಗಿದೆ",
  "Popular Products": "ಜನಪ್ರಿಯ ಉತ್ಪನ್ನಗಳು",
  "All Products": "ಎಲ್ಲಾ ಉತ್ಪನ್ನಗಳು",
  "Added to cart": "ಕಾರ್ಟ್‌ಗೆ ಸೇರಿಸಲಾಗಿದೆ",
  "Add to Cart": "ಕಾರ್ಟ್‌ಗೆ ಸೇರಿಸಿ",
  Add: "ಸೇರಿಸಿ",
  "Buy Now": "ಈಗ ಖರೀದಿಸಿ",
  "Currently unavailable": "ಪ್ರಸ್ತುತ ಲಭ್ಯವಿಲ್ಲ",
  "Out of stock": "ದಾಸ್ತಾನು ಇಲ್ಲ",
  "In stock": "ದಾಸ್ತಾನಿನಲ್ಲಿ ಇದೆ",
  "About the Company": "ಕಂಪನಿಯ ಬಗ್ಗೆ",
  "What we stand for": "ನಮ್ಮ ಧ್ಯೇಯ",
  "Built for procurement teams": "ಖರೀದಿ ತಂಡಗಳಿಗಾಗಿ ನಿರ್ಮಿಸಲಾಗಿದೆ",
  "Mill-direct sourcing": "ಮಿಲ್‌ನಿಂದ ನೇರ ಪೂರೈಕೆ",
  "S1, S2 and M30 grades procured straight from partner mills.": "ಪಾಲುದಾರ ಮಿಲ್‌ಗಳಿಂದ ನೇರವಾಗಿ S1, S2 ಮತ್ತು M30 ದರ್ಜೆಗಳ ಖರೀದಿ.",
  "Verified vendor network": "ಪರಿಶೀಲಿತ ಮಾರಾಟಗಾರರ ಜಾಲ",
  "KYC, GST and bank verification before the first listing.": "ಮೊದಲ ಪಟ್ಟಿಗೂ ಮುನ್ನ KYC, GST ಮತ್ತು ಬ್ಯಾಂಕ್ ಪರಿಶೀಲನೆ.",
  "Pan-India fulfilment": "ಭಾರತದಾದ್ಯಂತ ಪೂರೈಕೆ",
  "Freight partners covering 480+ pin codes.": "480ಕ್ಕೂ ಹೆಚ್ಚು ಪಿನ್ ಕೋಡ್‌ಗಳಿಗೆ ಸರಕು ಸಾಗಣೆ ಸೇವೆ.",
  "Enterprise ready": "ಉದ್ಯಮಗಳಿಗೆ ಸಿದ್ಧ",
  "Registered name": "ನೋಂದಾಯಿತ ಹೆಸರು",
  "Head office": "ಮುಖ್ಯ ಕಚೇರಿ",
  "Sugar · Rice · Oils · Pulses": "ಸಕ್ಕರೆ · ಅಕ್ಕಿ · ಎಣ್ಣೆ · ಬೇಳೆಕಾಳುಗಳು",
  "Contact Us": "ನಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸಿ",
  "Send an enquiry": "ವಿಚಾರಣೆ ಕಳುಹಿಸಿ",
  "Bulk quotes, vendor onboarding or order support.": "ದೊಡ್ಡ ಪ್ರಮಾಣದ ದರ, ಮಾರಾಟಗಾರರ ನೋಂದಣಿ ಅಥವಾ ಆರ್ಡರ್ ಸಹಾಯ.",
  "Full name": "ಪೂರ್ಣ ಹೆಸರು",
  Phone: "ಫೋನ್",
  Message: "ಸಂದೇಶ",
  "Submit Enquiry": "ವಿಚಾರಣೆ ಸಲ್ಲಿಸಿ",
  "Submitting…": "ಸಲ್ಲಿಸಲಾಗುತ್ತಿದೆ…",
  "Registered office": "ನೋಂದಾಯಿತ ಕಚೇರಿ",
  "Supply desk": "ಪೂರೈಕೆ ಸಹಾಯ ಕೇಂದ್ರ",
  "Enquiry submitted": "ವಿಚಾರಣೆ ಸಲ್ಲಿಸಲಾಗಿದೆ",
  "Our supply desk will respond within one business day.": "ನಮ್ಮ ಪೂರೈಕೆ ತಂಡ ಒಂದು ಕೆಲಸದ ದಿನದೊಳಗೆ ಉತ್ತರಿಸುತ್ತದೆ.",
  "About Us": "ನಮ್ಮ ಬಗ್ಗೆ",
  "Become a Vendor": "ಮಾರಾಟಗಾರರಾಗಿ",
  Company: "ಕಂಪನಿ",
  "Get in touch": "ಸಂಪರ್ಕಿಸಿ",
  "A premium multi-vendor marketplace for sugar and everyday essentials, operated by Shami Business Ventures Pvt. Ltd. with verified mills and institutional-grade logistics.": "ಪರಿಶೀಲಿತ ಮಿಲ್‌ಗಳು ಮತ್ತು ವಿಶ್ವಾಸಾರ್ಹ ಸಾಗಣೆ ವ್ಯವಸ್ಥೆಯೊಂದಿಗೆ Shami Business Ventures Pvt. Ltd. ನಡೆಸುವ ಸಕ್ಕರೆ ಮತ್ತು ದಿನಬಳಕೆ ವಸ್ತುಗಳ ಪ್ರೀಮಿಯಂ ಮಾರುಕಟ್ಟೆ.",
  "All rights reserved.": "ಎಲ್ಲ ಹಕ್ಕುಗಳನ್ನು ಕಾಯ್ದಿರಿಸಲಾಗಿದೆ.",
  Rice: "ಅಕ್ಕಿ",
  Sugar: "ಸಕ್ಕರೆ",
  Oil: "ಎಣ್ಣೆ",
  "Cooking Oil": "ಅಡುಗೆ ಎಣ್ಣೆ",
  Pulses: "ಬೇಳೆಕಾಳುಗಳು",
  Flours: "ಹಿಟ್ಟುಗಳು",
  Spices: "ಮಸಾಲೆಗಳು",
  "Dry Fruits": "ಒಣ ಹಣ್ಣುಗಳು",
  Jaggery: "ಬೆಲ್ಲ",
  Salt: "ಉಪ್ಪು",
  Description: "ವಿವರಣೆ",
  Specifications: "ವಿಶೇಷಣಗಳು",
  Vendor: "ಮಾರಾಟಗಾರ",
  "Customer Reviews": "ಗ್ರಾಹಕರ ವಿಮರ್ಶೆಗಳು",
  "Order Summary": "ಆರ್ಡರ್ ಸಾರಾಂಶ",
  Subtotal: "ಒಟ್ಟು ಮೊದಲು",
  Delivery: "ಡೆಲಿವರಿ",
  Total: "ಒಟ್ಟು",
  Checkout: "ಚೆಕ್‌ಔಟ್",
  "Proceed to Checkout": "ಚೆಕ್‌ಔಟ್‌ಗೆ ಮುಂದುವರಿಯಿರಿ",
  "Continue Shopping": "ಖರೀದಿ ಮುಂದುವರಿಸಿ",
  "Your cart is empty": "ನಿಮ್ಮ ಕಾರ್ಟ್ ಖಾಲಿಯಾಗಿದೆ",
  "Your wishlist is empty": "ನಿಮ್ಮ ಇಷ್ಟಪಟ್ಟ ಪಟ್ಟಿ ಖಾಲಿಯಾಗಿದೆ",
  Remove: "ತೆಗೆದುಹಾಕಿ",
  Quantity: "ಪ್ರಮಾಣ",
  Address: "ವಿಳಾಸ",
  Payment: "ಪಾವತಿ",
  Review: "ಪರಿಶೀಲನೆ",
  "Place Order": "ಆರ್ಡರ್ ಮಾಡಿ",
  "Order placed successfully": "ಆರ್ಡರ್ ಯಶಸ್ವಿಯಾಗಿ ಮಾಡಲಾಗಿದೆ",
  Previous: "ಹಿಂದಿನದು",
  Next: "ಮುಂದಿನದು",
  Save: "ಉಳಿಸಿ",
  Cancel: "ರದ್ದುಮಾಡಿ",
  Edit: "ತಿದ್ದುಪಡಿ",
  Delete: "ಅಳಿಸಿ",
  Update: "ನವೀಕರಿಸಿ",
  Submit: "ಸಲ್ಲಿಸಿ",
  Apply: "ಅನ್ವಯಿಸಿ",
  Clear: "ಅಳಿಸಿ",
  Filter: "ಫಿಲ್ಟರ್",
  Sort: "ವಿಂಗಡಿಸಿ",
  Status: "ಸ್ಥಿತಿ",
  Actions: "ಕ್ರಮಗಳು",
  Active: "ಸಕ್ರಿಯ",
  Disabled: "ನಿಷ್ಕ್ರಿಯ",
  Approved: "ಅನುಮೋದಿಸಲಾಗಿದೆ",
  Pending: "ಬಾಕಿ ಇದೆ",
  Rejected: "ತಿರಸ್ಕರಿಸಲಾಗಿದೆ",
  Processing: "ಸಿದ್ಧಪಡಿಸಲಾಗುತ್ತಿದೆ",
  Shipped: "ರವಾನಿಸಲಾಗಿದೆ",
  Delivered: "ತಲುಪಿಸಲಾಗಿದೆ",
  Cancelled: "ರದ್ದುಮಾಡಲಾಗಿದೆ",
  Paid: "ಪಾವತಿಸಲಾಗಿದೆ",
  Unpaid: "ಪಾವತಿಸಿಲ್ಲ",
  Refunded: "ಮರುಪಾವತಿಸಲಾಗಿದೆ",
  "No records found": "ಯಾವುದೇ ದಾಖಲೆಗಳು ಕಂಡುಬಂದಿಲ್ಲ",
  Name: "ಹೆಸರು",
  Price: "ಬೆಲೆ",
  Stock: "ದಾಸ್ತಾನು",
  Category: "ವರ್ಗ",
  Date: "ದಿನಾಂಕ",
  Customer: "ಗ್ರಾಹಕ",
  Order: "ಆರ್ಡರ್",
  Revenue: "ಆದಾಯ",
  Sales: "ಮಾರಾಟ",
};

const replacements: Array<[string, string]> = [
  ["Sunflower Oil", "ಸೂರ್ಯಕಾಂತಿ ಎಣ್ಣೆ"], ["Groundnut Oil", "ಕಡಲೆಕಾಯಿ ಎಣ್ಣೆ"], ["Palm Oil", "ಪಾಮ್ ಎಣ್ಣೆ"],
  ["Refined Sugar", "ಸಂಸ್ಕರಿಸಿದ ಸಕ್ಕರೆ"], ["Sugar Retail Pack", "ಸಕ್ಕರೆ ಚಿಲ್ಲರೆ ಪ್ಯಾಕ್"], ["Sugar Cubes", "ಸಕ್ಕರೆ ಘನಗಳು"],
  ["Steam Rice", "ಬೇಯಿಸಿದ ಅಕ್ಕಿ"], ["Raw Rice", "ಕಚ್ಚಾ ಅಕ್ಕಿ"], ["Basmati", "ಬಾಸ್ಮತಿ"], ["Idli Rice", "ಇಡ್ಲಿ ಅಕ್ಕಿ"],
  ["Premium Rice", "ಪ್ರೀಮಿಯಂ ಅಕ್ಕಿ"], ["Grade A", "A ದರ್ಜೆ"], ["Grade B", "B ದರ್ಜೆ"], ["Grade S1", "S1 ದರ್ಜೆ"],
  ["Retail Pack", "ಚಿಲ್ಲರೆ ಪ್ಯಾಕ್"], ["Bulk", "ದೊಡ್ಡ ಪ್ಯಾಕ್"], ["Bag", "ಚೀಲ"], ["Tin", "ಟಿನ್"], ["Can", "ಕ್ಯಾನ್"], ["Pouch", "ಪೌಚ್"], ["Box", "ಪೆಟ್ಟಿಗೆ"],
  ["Pack Size", "ಪ್ಯಾಕ್ ಗಾತ್ರ"], ["Shelf Life", "ಬಳಕೆಯ ಅವಧಿ"], ["Storage", "ಸಂಗ್ರಹಣೆ"], ["Country of Origin", "ಮೂಲ ದೇಶ"],
  ["12 months from packing", "ಪ್ಯಾಕ್ ಮಾಡಿದ ದಿನದಿಂದ 12 ತಿಂಗಳು"], ["Cool, dry place away from sunlight", "ಸೂರ್ಯನ ಬೆಳಕಿನಿಂದ ದೂರ ತಂಪಾದ ಒಣ ಸ್ಥಳ"], ["India", "ಭಾರತ"],
  ["Total Orders", "ಒಟ್ಟು ಆರ್ಡರ್‌ಗಳು"], ["Total Products", "ಒಟ್ಟು ಉತ್ಪನ್ನಗಳು"], ["Total Customers", "ಒಟ್ಟು ಗ್ರಾಹಕರು"], ["Total Vendors", "ಒಟ್ಟು ಮಾರಾಟಗಾರರು"],
  ["Low Stock", "ಕಡಿಮೆ ದಾಸ್ತಾನು"], ["Order ID", "ಆರ್ಡರ್ ID"], ["Product Name", "ಉತ್ಪನ್ನದ ಹೆಸರು"], ["Customer Name", "ಗ್ರಾಹಕರ ಹೆಸರು"],
  ["Add New", "ಹೊಸದನ್ನು ಸೇರಿಸಿ"], ["Save Changes", "ಬದಲಾವಣೆಗಳನ್ನು ಉಳಿಸಿ"], ["View Details", "ವಿವರಗಳನ್ನು ನೋಡಿ"], ["Download", "ಡೌನ್‌ಲೋಡ್"],
  ["per page", "ಪ್ರತಿ ಪುಟಕ್ಕೆ"], ["Showing", "ತೋರಿಸಲಾಗುತ್ತಿದೆ"], ["results", "ಫಲಿತಾಂಶಗಳು"], ["of", "ರಲ್ಲಿ"],
];

function replaceEnglish(value: string) {
  let output = value;
  for (const [from, to] of replacements) {
    output = output.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), to);
  }
  return output;
}

export function translateText(value: string, language: Language) {
  if (language === "en" || !value.trim()) return value;
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const core = value.trim();
  const translated = exact[core] ?? replaceEnglish(core);
  return `${leading}${translated}${trailing}`;
}

type LanguageContextValue = {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (value: string) => string;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

const translatedAttributes = ["placeholder", "aria-label", "title", "alt"] as const;

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>("en");
  const languageRef = useRef<Language>("en");
  const textSources = useRef(new WeakMap<Text, string>());
  const attributeSources = useRef(new WeakMap<Element, Map<string, string>>());

  const applyLanguage = useCallback((root: ParentNode, nextLanguage: Language) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = node as Text;
      const parent = text.parentElement;
      if (parent && !parent.closest("[data-no-translate]") && !["SCRIPT", "STYLE"].includes(parent.tagName)) {
        const knownSource = textSources.current.get(text);
        const source = knownSource ?? text.nodeValue ?? "";
        textSources.current.set(text, source);
        const translated = translateText(source, nextLanguage);
        if (text.nodeValue !== translated) text.nodeValue = translated;
      }
      node = walker.nextNode();
    }

    const elements = root instanceof Element ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
    for (const element of elements) {
      if (element.closest("[data-no-translate]")) continue;
      let sources = attributeSources.current.get(element);
      if (!sources) {
        sources = new Map<string, string>();
        attributeSources.current.set(element, sources);
      }
      for (const attribute of translatedAttributes) {
        const current = element.getAttribute(attribute);
        if (current === null) continue;
        if (!sources.has(attribute)) sources.set(attribute, current);
        const source = sources.get(attribute) ?? current;
        element.setAttribute(attribute, translateText(source, nextLanguage));
      }
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const initial: Language = saved === "kn" ? "kn" : "en";
    languageRef.current = initial;
    setLanguageState(initial);
    document.documentElement.lang = initial === "kn" ? "kn" : "en";
    applyLanguage(document.body, initial);

    const observer = new MutationObserver((mutations) => {
      observer.disconnect();
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          const text = mutation.target as Text;
          const previous = textSources.current.get(text);
          const expected = previous ? translateText(previous, languageRef.current) : undefined;
          if (!previous || text.nodeValue !== expected) textSources.current.set(text, text.nodeValue ?? "");
          if (text.parentNode) applyLanguage(text.parentNode, languageRef.current);
        } else {
          for (const added of mutation.addedNodes) {
            if (added.nodeType === Node.TEXT_NODE) {
              const text = added as Text;
              textSources.current.set(text, text.nodeValue ?? "");
              if (text.parentNode) applyLanguage(text.parentNode, languageRef.current);
            } else if (added instanceof Element) {
              applyLanguage(added, languageRef.current);
            }
          }
        }
      }
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [applyLanguage]);

  const setLanguage = useCallback((nextLanguage: Language) => {
    languageRef.current = nextLanguage;
    setLanguageState(nextLanguage);
    localStorage.setItem(STORAGE_KEY, nextLanguage);
    document.documentElement.lang = nextLanguage === "kn" ? "kn" : "en";
    applyLanguage(document.body, nextLanguage);
  }, [applyLanguage]);

  const value = useMemo<LanguageContextValue>(() => ({
    language,
    setLanguage,
    t: (text) => translateText(text, language),
  }), [language, setLanguage]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used inside LanguageProvider");
  return context;
}