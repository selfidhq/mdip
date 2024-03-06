#/usr/bin/env bash 
_kc_completions()
{
  COMPREPLY+=("create-wallet")
  COMPREPLY+=("import-wallet")
  COMPREPLY+=("show-wallet")                                
  COMPREPLY+=("show-mnemonic")                             
  COMPREPLY+=("backup-wallet")                            
  COMPREPLY+=("recover-wallet")
  COMPREPLY+=("create-id")
  COMPREPLY+=("resolve-id")                            
  COMPREPLY+=("backup-id")                            
  COMPREPLY+=("recover-id")
  COMPREPLY+=("remove-id")                   
  COMPREPLY+=("list-ids")                      
  COMPREPLY+=("use-id")                    
  COMPREPLY+=("rotate-keys")                     
  COMPREPLY+=("resolve-did")              
  COMPREPLY+=("encrypt-msg")       
  COMPREPLY+=("encrypt-file")    
  COMPREPLY+=("decrypt-did")           
  COMPREPLY+=("decrypt-json")         
  COMPREPLY+=("sign-file")                            
  COMPREPLY+=("verify-file")                          
  COMPREPLY+=("create-credential")            
  COMPREPLY+=("create-challenge")            
  COMPREPLY+=("create-challenge-cc")         
  COMPREPLY+=("issue-challenge")          
  COMPREPLY+=("bind-credential")               
  COMPREPLY+=("attest-credential")
  COMPREPLY+=("revoke-credential")                  
  COMPREPLY+=("accept-credential")                 
  COMPREPLY+=("publish-credential")               
  COMPREPLY+=("reveal-credential")               
  COMPREPLY+=("unpublish-credential")           
  COMPREPLY+=("create-response")        
  COMPREPLY+=("verify-response")              
  COMPREPLY+=("add-name")             
  COMPREPLY+=("remove-name")               
  COMPREPLY+=("list-names")                      
  COMPREPLY+=("export-did")               
  COMPREPLY+=("import-did")             
  COMPREPLY+=("help")               
}

