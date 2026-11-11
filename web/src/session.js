// Who is signed in. Any screen can read it with useSession().
import { createContext, useContext } from 'react';

export const Session = createContext(null);
export const useSession = () => useContext(Session);
