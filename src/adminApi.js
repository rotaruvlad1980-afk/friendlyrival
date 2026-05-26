import { supabase } from './supabase.js';

export async function createUser(username, displayName, password, isAdmin = false) {
  const email = `${username.toLowerCase()}@friendlyrival.app`;

  // Creează userul prin Supabase Admin API
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username, display_name: displayName }
    }
  });

  if (error) return { error: error.message };
  if (!data.user) return { error: 'User negasit dupa creare.' };

  // Creează profilul
  const { error: profileError } = await supabase.from('profiles').insert({
    id: data.user.id,
    username: username.toLowerCase(),
    display_name: displayName,
    is_admin: isAdmin,
  });

  if (profileError) return { error: profileError.message };
  return { success: true };
}

export async function deleteUser(userId) {
  await supabase.from('profiles').delete().eq('id', userId);
  return { success: true };
}
