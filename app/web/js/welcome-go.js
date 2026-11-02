/* The welcome page is for people who haven't signed in on this device yet. Anyone who has goes straight to the app
   (keeping ?dm=… and the like from notifications). Runs in <head>, before the page is drawn. */
try { if (localStorage.getItem('pl:token')) location.replace('/app' + location.search + location.hash); } catch {}
