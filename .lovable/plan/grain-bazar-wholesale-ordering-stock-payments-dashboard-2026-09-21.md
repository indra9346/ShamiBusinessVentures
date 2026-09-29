# Grain Bazar — wholesale ordering, stock, payments, dashboard

Keeps the current navy/gold look, fonts, buttons and all working pages. Nothing is redesigned; sections are cleaned up, and new capability is added on top. Delivered in phases so each one is usable immediately.

## Phase 1 — Branding, homepage, search (first delivery)
- Show the business name **GRAIN BAZAR** beside the existing logo in the top bar and sign-in screens.
- Homepage starts directly with **Shop by Category / ವರ್ಗದ ಮೂಲಕ ಖರೀದಿ**. The large promotional banner, trust strip and extra calls-to-action are removed; popular products stay below the categories.
- Search bar made smaller and moved to the top of the clean homepage.
- Search now matches category, brand, product code, product name and Kannada name.

## Phase 2 — Ordering flow (Category → Product → Quantity → Cart → Confirm → 30% advance)
- Product screen shows name, image, product code, stock, brand, bag/unit type, capacity/weight, price and quantity.
- Minus/plus controls plus direct typing for bags, quantity, weight, capacity and required amount; totals update instantly.
- Cart gets a clear **Edit / ಬದಲಾಯಿಸಿ** action; no extra pages between cart and confirmation.
- **Reorder / ಮರುಆರ್ಡರ್** from any past order in one tap.
- Order confirmation shows Total, 30% advance, Paid, Pending and payment status, calculated automatically for orders up to ₹1,00,000.

## Phase 3 — Payments and matching
- Payment statuses: Pending, Payment Submitted, Under Verification, Confirmed, Partially Paid, Fully Paid, Failed.
- Payment records store amount, UTR, received by, verified by, date/time, customer or vendor, order number and status — kept permanently.
- Admin payment screen with a prominent **Match Payment / ಪಾವತಿಯನ್ನು ಹೊಂದಿಸಿ** action, matching on business/customer/vendor, amount, UTR, phone, order number and date.

## Phase 4 — Admin quick actions, categories, products, stock
- Quick action row: Add Product, Add Category, Add Customer, Add Vendor, Add Order, Payment, Stock, Reports, Export Excel — each opening a single short form.
- Category add/edit/delete/enable/disable with name (English + Kannada), image/icon and status.
- Product add/edit with code, category, brand, image (add/replace/remove), price, capacity/weight, bag type, stock, minimum stock, required stock and status.
- Stock panel per product: current, required, warehouse, next 15–20 days requirement, shortage, low-stock flag, with quick +/− controls. **Low Stock / ಕಡಿಮೆ ಸ್ಟಾಕ್** appears automatically and notifies admin.
- Purchase frequency grouping: Frequently Ordered, Recently Ordered, Regular, Other — frequently ordered first.

## Phase 5 — Customers, vendors, dashboard, Excel, notifications, WhatsApp
- Customer/vendor profiles: business name, contact person, phone, WhatsApp, email, address, GST, payment details, order history, payment history, pending amount, total business value, regular status, notes. One-tap **Regular** status update. Checkout itself stays short.
- Customer profile charts: orders, purchase amount, payment history, pending payment, frequently purchased products, monthly business value, order frequency.
- Admin dashboard: today's sales, orders, payments, pending payments, expenses, customers, vendors, low stock, outstanding amount, with daily/monthly/yearly graphs and filters (date range, customer, vendor, product, category, payment status, amount, expenses, payment member).
- **Export Excel / ಎಕ್ಸೆಲ್‌ಗೆ ರಫ್ತು ಮಾಡಿ** honouring active filters, with customer, vendor, business, product, quantity, bags, weight, order amount, 30% advance, paid, pending, UTR, payment status, payment member, date, expenses and order status.
- One notifications centre for orders, payments, verification, balance, low stock, stock requirement, customer/vendor added and status changes — short, professional messages.
- WhatsApp requirement → order: one screen to pick customer and products and edit bags, weight, capacity, quantity and total.

## Phase 6 — Bilingual everywhere
- The existing ಕನ್ನಡ | English switcher stays one tap and is extended to every admin, vendor and customer screen: forms, errors, success messages, popups, status labels, reports, graph labels, Excel headers and WhatsApp messages.
- Categories and products store English and Kannada names separately (Rice / ಅಕ್ಕಿ, Sunflower Oil / ಸೂರ್ಯಕಾಂತಿ ಎಣ್ಣೆ), editable in admin.
- Natural Karnataka Kannada wording, reviewed phrase by phrase, replacing machine-style text.

## Technical notes
- Data lives in the existing Lovable Cloud tables; new fields (Kannada names, product code, brand, bag type, capacity, required/warehouse stock, UTR and verification fields, expenses) are added additively so nothing existing breaks.
- Lifetime history is append-only: no automatic deletion of orders, payments, stock movements or transactions.
- Excel export is generated in the browser from the already-filtered list, so no new service is needed.
- Translations move to a per-key English/Kannada store so more languages can be added later without touching screens.

## Rule applied to every screen
One screen → one action → one tap. Quick Add, Quick Edit, Quick Payment, Quick Stock Update, Quick Reorder, Quick Status Update, Quick Export. No extra popups or deep navigation.
