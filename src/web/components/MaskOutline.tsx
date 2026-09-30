/**
 * SVG filter that draws a two-tone outline around the tinted mask overlay: a white ring hugging the mask, then a dark
 * ring outside it, so the selection edge reads on any subject (the amber tint alone vanishes on yellow/orange).
 *
 * Applied with CSS `filter: url(#dr-mask-outline)` to the overlay canvas. Filter primitives work in the canvas's CSS
 * pixels (it is sized to the zoomed picture, not transformed), so the outline stays the same thickness at any zoom.
 * The stored mask and exported PNG are untouched; this is display only.
 */
export const MASK_OUTLINE_FILTER = 'url(#dr-mask-outline)';

export function MaskOutlineDefs() {
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
      <filter id="dr-mask-outline" x="-2%" y="-2%" width="104%" height="104%" colorInterpolationFilters="sRGB">
        {/* solid version of the mask shape (the tint itself is only ~55 % opaque) */}
        <feComponentTransfer in="SourceAlpha" result="shape">
          <feFuncA type="linear" slope="4" />
        </feComponentTransfer>
        <feMorphology in="shape" operator="dilate" radius="1.5" result="inner" />
        <feMorphology in="shape" operator="dilate" radius="3" result="outer" />
        <feFlood floodColor="#ffffff" floodOpacity="0.95" />
        <feComposite in2="inner" operator="in" result="white" />
        <feFlood floodColor="#000000" floodOpacity="0.8" />
        <feComposite in2="outer" operator="in" result="dark" />
        <feMerge result="rings">
          <feMergeNode in="dark" />
          <feMergeNode in="white" />
        </feMerge>
        {/* keep only the part outside the mask, so the tinted fill is not washed out */}
        <feComposite in="rings" in2="shape" operator="out" result="ring" />
        <feMerge>
          <feMergeNode in="ring" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </svg>
  );
}
