import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  nativeDashboardSchema,
  type NativeDashboard,
  type NativeRepository,
} from "../shared/native.js";
import { api } from "./api.js";

export const nativeQueryKey = ["native"] as const;

export function useNativeDashboard() {
  return useQuery({
    queryKey: nativeQueryKey,
    queryFn: () => api("/api/native", nativeDashboardSchema),
    refetchInterval: 30_000,
    retry: false,
  });
}

export function replaceNativeRepository(
  client: QueryClient,
  repository: NativeRepository,
) {
  client.setQueryData<NativeDashboard>(nativeQueryKey, (current) =>
    current
      ? {
          ...current,
          repositories: current.repositories.map((item) =>
            item.id === repository.id ? repository : item,
          ),
        }
      : current,
  );
}
