/**
 * Support Tickets API — frontend
 * Connecte SupportView à la vraie API /api/support (PostgreSQL).
 */
import { apiRequest } from "./client";

export interface SupportTicket {
  id: string;
  title: string;
  clientName: string;
  description?: string;
  priority: "low" | "medium" | "high";
  status: "open" | "in_progress" | "resolved" | "closed";
  userId?: string;
  user?: { id: string; name: string; email: string };
  createdAt: string;
  updatedAt: string;
}

export async function fetchTickets(status?: string): Promise<SupportTicket[]> {
  try {
    const qs = status ? `?status=${status}` : "";
    const data = await apiRequest<{ tickets: SupportTicket[] }>(`/support${qs}`);
    return data.tickets || [];
  } catch (err) {
    console.error("Error fetching tickets:", err);
    return [];
  }
}

export async function createTicket(data: {
  title: string;
  clientName: string;
  description?: string;
  priority?: "low" | "medium" | "high";
}): Promise<SupportTicket> {
  return await apiRequest<SupportTicket>("/support", {
    method: "POST",
    body: data,
  });
}

export async function updateTicket(
  id: string,
  updates: { status?: string; priority?: string; title?: string; description?: string }
): Promise<SupportTicket> {
  return await apiRequest<SupportTicket>(`/support/${id}`, {
    method: "PATCH",
    body: updates,
  });
}

export async function deleteTicket(id: string): Promise<void> {
  await apiRequest(`/support/${id}`, { method: "DELETE" });
}
