import type { Fix } from "@/lib/attendance";

/**
 * The phone's best GPS position within a few seconds: positions keep arriving while GPS locks on,
 * so take the most accurate one, stopping early once it is within 25 m.
 */
export function getBestFix(timeoutMs = 12_000): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) { reject(new Error("This phone or browser can't share its location")); return; }
    let best: Fix | null = null;
    let watch = 0;
    const finish = () => {
      navigator.geolocation.clearWatch(watch);
      clearTimeout(timer);
      if (best) resolve(best);
      else reject(new Error("Location not found. Go outside or near a window, switch on GPS and try again."));
    };
    const timer = setTimeout(finish, timeoutMs);
    watch = navigator.geolocation.watchPosition(
      (position) => {
        const fix = { lat: position.coords.latitude, lng: position.coords.longitude, accuracyM: Math.round(position.coords.accuracy) };
        if (!best || fix.accuracyM < best.accuracyM) best = fix;
        if (fix.accuracyM <= 25) finish();
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          navigator.geolocation.clearWatch(watch);
          clearTimeout(timer);
          reject(new Error("Location permission is blocked. Allow location for grainbazar.com in your browser settings and switch on GPS."));
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
    );
  });
}
