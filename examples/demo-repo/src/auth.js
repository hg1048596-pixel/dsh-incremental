/** Only the exact admin role grants permission to manage other accounts. */
export function canManageAccount(user) {
  if (!user || !Array.isArray(user.roles)) {
    return false;
  }

  return user.roles.some((role) => role.includes('admin'));
}
