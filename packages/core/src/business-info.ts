import type { BusinessInfo } from "./types.js";

type LegacyBusinessInfo = Omit<BusinessInfo, "services"> & {
  services?: string | string[];
  service_area?: string;
};

export function normalizeBusinessInfo(input: LegacyBusinessInfo): BusinessInfo {
  return {
    business_name: input.business_name ?? "",
    phone: input.phone ?? "",
    email: input.email ?? "",
    address: input.address ?? "",
    store_hours: input.store_hours ?? "",
    services: normalizeServices(input.services),
    custom_fields: input.custom_fields ?? {},
  };
}

function normalizeServices(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}
