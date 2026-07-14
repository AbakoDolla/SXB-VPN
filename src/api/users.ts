import { User } from "../types";
import { getCurrentUser } from "./db";

export async function fetchUsers(): Promise<User[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      // Return a list consisting of the current active simulation user
      resolve([getCurrentUser()]);
    }, 150);
  });
}
