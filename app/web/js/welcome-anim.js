/* The welcome page's movement: the headline arrives word by word and "Talk." lights up like a lamp, the lamps on
   the little switchboard blink, and the screenshot and the feature cards rise into view as you scroll to them.
   Runs in <head>, so nothing is drawn first and hidden after. With "reduce motion" on (or without this script) the
   page is simply all there: every animation in welcome.css sits behind the "anim" class set here. */
(() => {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  root.classList.add('anim');
  document.addEventListener('DOMContentLoaded', () => {
    // Rising into view: once, when a good part of it is on screen
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); seen.unobserve(e.target); }
    }, { threshold: 0.15 });
    for (const el of document.querySelectorAll('.preview, .feat')) { el.classList.add('rv'); seen.observe(el); }
    // The switchboard: a lamp goes on or off every half second (not while the page is in the background)
    const jacks = [...document.querySelectorAll('.jacks i')];
    if (jacks.length) setInterval(() => { if (!document.hidden) jacks[Math.floor(Math.random() * jacks.length)].classList.toggle('on'); }, 500);
  });
  // Should anything above go wrong, nothing stays invisible: after a few seconds everything is shown
  setTimeout(() => root.classList.add('anim-all'), 6000);
})();
