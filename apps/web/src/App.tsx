import { lazy } from 'react';
import { Route, Routes } from 'react-router';
import { AppShell } from './components/layout/AppShell';
import { RequireAuth } from './lib/auth';

// Each page is its own chunk, loaded when first visited.
const Home = lazy(() => import('./pages/Home'));
const Event = lazy(() => import('./pages/Event'));
const Checkout = lazy(() => import('./pages/Checkout'));
const OrderConfirmation = lazy(() => import('./pages/OrderConfirmation'));
const Tickets = lazy(() => import('./pages/Tickets'));
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const Lab = lazy(() => import('./pages/Lab'));
const NotFound = lazy(() => import('./pages/NotFound'));
const AdminEvents = lazy(() => import('./pages/admin/AdminEvents'));
const AdminNewEvent = lazy(() => import('./pages/admin/AdminNewEvent'));
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'));
const AdminCheckin = lazy(() => import('./pages/admin/AdminCheckin'));

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Home />} />
        <Route path="events/:slug" element={<Event />} />
        <Route path="login" element={<Login />} />
        <Route path="register" element={<Register />} />
        <Route path="lab" element={<Lab />} />

        <Route element={<RequireAuth />}>
          <Route path="checkout/:holdId" element={<Checkout />} />
          <Route path="orders/:id" element={<OrderConfirmation />} />
          <Route path="tickets" element={<Tickets />} />
        </Route>

        <Route path="admin" element={<RequireAuth role="admin" />}>
          <Route index element={<AdminEvents />} />
          <Route path="events/new" element={<AdminNewEvent />} />
          <Route path="events/:id" element={<AdminDashboard />} />
          <Route path="checkin" element={<AdminCheckin />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
