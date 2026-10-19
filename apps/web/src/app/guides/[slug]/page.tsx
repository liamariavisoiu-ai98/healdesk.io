import { familyRoute } from "@/lib/content/family-route";

const route = familyRoute("guides");

export const dynamicParams = false;
export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
