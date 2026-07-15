import { User } from "../types";
import { apiRequest } from "./client";

export async function fetchUsers(): Promise<User[]> {
  try {
    const data = await apiRequest<{ users: User[] }>("/users");
    return data.users || [];
  } catch (error) {
    console.error("Error fetching users:", error);
    return [];
  }
}

export async function createUser(userData: {
  name: string;
  email: string;
  password?: string; // optionnel — auto-généré par le backend si absent
  phone?: string;
  roleId?: string;
}): Promise<User & { generatedPassword?: string }> {
  return await apiRequest<User & { generatedPassword?: string }>("/users", {
    method: "POST",
    body: userData,
  });
}

export async function updateUser(id: string, updates: Partial<User>): Promise<User> {
  return await apiRequest<User>(`/users/${id}`, {
    method: "PATCH",
    body: updates,
  });
}

export async function deleteUser(id: string): Promise<void> {
  await apiRequest(`/users/${id}`, { method: "DELETE" });
}
