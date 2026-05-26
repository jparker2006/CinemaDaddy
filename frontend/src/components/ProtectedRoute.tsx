import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function ProtectedRoute() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-loading" aria-hidden="true" />;
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}
