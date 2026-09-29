import { Bell, FileText, Heart, LayoutDashboard, MapPin, Package, Settings, Star, Truck, User } from "lucide-react";

export const accountNav = [
  { label: "Dashboard", to: "/account", icon: LayoutDashboard },
  { label: "My Profile", to: "/account/profile", icon: User },
  { label: "My Orders", to: "/account/orders", icon: Package },
  { label: "Track Orders", to: "/account/track", icon: Truck },
  { label: "Wishlist", to: "/wishlist", icon: Heart },
  { label: "Saved Addresses", to: "/account/addresses", icon: MapPin },
  { label: "Reviews & Ratings", to: "/account/reviews", icon: Star },
  { label: "Notifications", to: "/account/notifications", icon: Bell },
  { label: "Invoices", to: "/account/invoices", icon: FileText },
  { label: "Account Settings", to: "/account/settings", icon: Settings },
];
