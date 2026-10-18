import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/manrope";
import "@fontsource-variable/newsreader";
import "./styles.css";
import { App } from "./App.js";

const client = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: false },
    mutations: { retry: false },
  },
});
const element = document.getElementById("root");
if (!element) throw new Error("The app mount point is missing.");
createRoot(element).render(
  <QueryClientProvider client={client}>
    <App />
  </QueryClientProvider>,
);
