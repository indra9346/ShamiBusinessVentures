import { useEffect, useRef, useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False in the server's HTML and until the page's scripts have taken over. A sign-in form keeps its
 * button off until then: pressed earlier, the browser would submit the form itself, so nobody gets
 * signed in and they have to type it all again.
 */
export const useHydrated = () => useSyncExternalStore(subscribe, () => true, () => false);

/**
 * For a form field: keeps what was typed or autofilled before the page's scripts took over. The
 * field's state is still empty then, so React would blank the box on its next render.
 */
export function useKeepEarlyInput(setValue: (value: string) => void) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current?.value) setValue(ref.current.value);
    // Once, when the scripts take over; after that the field's own onChange keeps its state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}
