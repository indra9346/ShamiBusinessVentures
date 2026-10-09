// TypeScript definitions for Supabase Deno Edge Functions
declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
};

declare module "https://*" {
  export const serve: (handler: (req: Request) => Promise<Response> | Response) => void;
}
