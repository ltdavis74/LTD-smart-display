```markdown
# Design System Strategy: The Boreal Lens

## 1. Overview & Creative North Star
**Creative North Star: "The Silent Sentinel"**

This design system moves away from the "gadget" feel of traditional smart displays, instead adopting an **Editorial Wilderness** aesthetic. Inspired by the Canadian Shield—the ancient granite, the stoic pines, and the deep, cold waters of the Boundary Waters—the UI is designed to be a quiet, high-end companion. 

To break the "template" look, we utilize **Intentional Asymmetry**. Rather than a rigid grid of squares, we lean into a "layered vista" approach. Elements should feel like they are floating over a landscape, using varied widths and overlapping glass containers to create a sense of organic depth. Information is not just "displayed"; it is curated with a high-contrast typographic scale that ensures glanceability from across a room.

## 2. Colors: The Tonal Palette
The palette is derived from the natural world—slate, lichen, and deep water. It is optimized for high-contrast legibility against dark, moody backgrounds.

### The "No-Line" Rule
**Borders are strictly prohibited for sectioning.** To define a boundary, use tonal shifts between surface tiers (e.g., a `surface_container_high` card sitting on a `surface` background). This creates a sophisticated, seamless appearance that mimics the transition from stone to moss.

### Surface Hierarchy & Nesting
Treat the 1024x600 canvas as a physical environment. 
*   **Base:** Use `surface` (#121416) for the primary background.
*   **Mid-Ground:** Use `surface_container_low` (#1a1c1e) for large functional areas.
*   **Foreground:** Use `surface_container_highest` (#333537) for interactive elements like buttons or active states.

### The "Glass & Gradient" Rule
To achieve the premium "DAKboard" feel, floating widgets must use **Glassmorphism**. 
*   **Formula:** Apply `surface_variant` at 40-60% opacity with a `backdrop-filter: blur(20px)`. 
*   **Signature Textures:** Use a subtle linear gradient (135°) from `primary` to `primary_container` for hero elements (like the current temperature or time). This provides a "visual soul" that flat colors cannot achieve.

## 3. Typography: The Manrope Editorial
We use **Manrope** exclusively. Its geometric yet humanist qualities provide the modern, clean look required for high-end digital experiences.

*   **Display (Lg/Md):** Used for "Hero Moments"—the time, the outdoor temperature, or a headline news item. These should feel authoritative and provide the anchor for the layout.
*   **Headline & Title:** Used to categorize information (e.g., "Calendar," "Water Intake"). These use `primary` color tokens to draw the eye.
*   **Body:** Used for secondary information. Use `body-lg` for readability at a distance (6–10 feet).
*   **Labels:** Small, all-caps, or high-tracking metadata. These use `on_surface_variant` to recede in the hierarchy.

The hierarchy is built on **Weight & Space**. A `display-lg` time element paired with a `label-md` date creates an editorial "pull" that guides the user’s eye instantly to the most critical data.

## 4. Elevation & Depth: The Layering Principle
We reject traditional drop shadows in favor of **Tonal Layering** and **Atmospheric Perspective.**

*   **Ambient Shadows:** If a "floating" effect is needed for a modal or a primary action button, use a highly diffused shadow: `box-shadow: 0 20px 40px rgba(12, 14, 16, 0.4)`. The shadow should feel like a soft mist, not a harsh edge.
*   **The "Ghost Border" Fallback:** If a container requires further definition against a complex background photo, use a **Ghost Border**. Apply `outline_variant` at **15% opacity**. This creates a microscopic "glint" on the edge of the glass, mimicking the way light hits the edge of a polished granite slab.
*   **Interpenetration:** Allow elements to slightly overlap. A weather icon can break the boundary of its container, adding a sense of three-dimensionality and custom craftsmanship.

## 5. Components: Functional Elegance

### Buttons & Chips
*   **Primary Button:** Uses `primary` background with `on_primary` text. Apply `xl` (0.75rem) roundedness for a soft, tactile feel.
*   **Selection Chips:** Avoid boxes; use a `surface_container_highest` fill for selected states and no fill (just text) for unselected.
*   **Touch Targets:** Ensure all interactive elements have a minimum 48x48px hit area, even if the visual element is smaller.

### Cards & Lists
*   **No Dividers:** Horizontal lines are banned. To separate list items (e.g., calendar events), use 16px of vertical spacing or a subtle background shift to `surface_container_low` on alternating items.
*   **Progressive Disclosure:** For the 1024x600 screen, cards should be "glance-first." Use `title-lg` for the primary metric and `body-sm` for the supporting detail.

### Input Fields
*   **Minimalist Slate:** Use `surface_container_lowest` with a "Ghost Border." The focus state should transition the border to `primary` and increase the backdrop blur density.

### Contextual Widgets (Smart Display Specific)
*   **The "Vista" Widget:** A large-scale background image container with a bottom-to-top gradient fade (from transparent to `surface`) to ensure text legibility at the base of the screen.

## 6. Do’s and Don’ts

### Do:
*   **DO** use whitespace as a separator. The "Boundary Waters" feel requires breathing room.
*   **DO** use `secondary` (Pine Green) and `tertiary` (Slate Blue) to color-code different categories of information (e.g., Green for Health/Activity, Blue for Weather).
*   **DO** ensure the "Time" is always the largest element in the layout.

### Don't:
*   **DON'T** use 100% black (#000000). Use `surface` (#121416) to maintain the "Granite" depth.
*   **DON'T** use hard-edged, opaque cards. This breaks the "Glassmorphism" immersion.
*   **DON'T** crowd the edges of the 1024x600 display. Maintain a minimum "Safe Zone" margin of 40px on all sides to allow the hardware bezel to blend into the UI.
*   **DON'T** use icons with varying stroke weights. Stick to a 2px consistent stroke to match Manrope’s geometry.

---
*Design Note: Every pixel should feel as intentional as a weathered stone in a stream. If an element doesn't serve a purpose for a user standing 6 feet away, remove it.*```