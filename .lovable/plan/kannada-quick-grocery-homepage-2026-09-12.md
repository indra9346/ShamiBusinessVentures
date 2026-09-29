# Kannada Quick-Grocery Homepage

## Scope
- Update only `src/routes/index.tsx`; keep the shared header, footer, product data, routes, category pages, cart, checkout, account, admin, vendor, and backend untouched.
- Preserve Shami’s navy, gold, ivory, logo, and existing shopping actions.

## Homepage changes
- Build a compact mobile-first Kannada introduction with the requested headline, supporting text, and a prominent product search that opens the existing shop results.
- Add three large, easy-to-tap category choices—ಅಕ್ಕಿ, ಸಕ್ಕರೆ, ಎಣ್ಣೆ—using the existing premium category photographs and existing category routes.
- Replace the many repeated product bands with one focused “ಜನಪ್ರಿಯ ಉತ್ಪನ್ನಗಳು” area backed by existing storefront products.
- Keep current product information and reuse existing cart and buy-now behavior, while localizing homepage-only labels such as ಸೇರಿಸಿ, ಈಗ ಖರೀದಿಸಿ, ಕಾರ್ಟ್, and ಎಲ್ಲವನ್ನೂ ನೋಡಿ.
- Keep a compact trust strip using existing business claims, translated into natural Kannada.

## Technical details
- Add small homepage-local category and product-card renderers inside the existing homepage file to avoid changing shared components used elsewhere.
- Use existing semantic color utilities, current image assets, and TanStack links/search parameters.
- Include complete route metadata in the homepage head without changing other routes.

## Validation
- Verify desktop and mobile layouts in the running preview.
- Confirm search, category links, add-to-cart, buy-now, cart, and account access remain functional without horizontal overflow.
