# English and Kannada language support

## Scope
Add only bilingual text support. Preserve every existing page structure, visual style, product/category record, route, and interaction.

## Implementation
- Add a lightweight shared language provider with English as the initial default and the selected language saved in the browser.
- Add a compact `English | ಕನ್ನಡ` control to the existing shared public header, panel header, and sign-in layout so it remains available throughout the site without restructuring pages.
- Translate visible interface text, accessibility labels, placeholders, notifications, status labels, generated descriptions, category names, and product names/details using a central Kannada dictionary and phrase rules.
- Restore the homepage’s source copy to English so English is truly the default; its current Kannada wording will remain available through the Kannada selection.
- Update the document language when switching and keep the choice active during navigation and page refreshes.

## Technical details
- No new package will be installed.
- Existing JSX structure and class names will remain unchanged except for inserting the language control in shared headers.
- Translation will be applied through one shared React layer, including dynamic text from the existing mock data, avoiding changes to business logic or stored records.
- Validate representative storefront, account, vendor, and admin pages in both languages, plus refresh persistence, navigation persistence, mobile layout, and browser errors.
