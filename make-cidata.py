import os, sys, pycdlib

out = sys.argv[1]
name = sys.argv[2] if len(sys.argv) > 2 else 'vm'
tmp = os.path.dirname(out)
ud = os.path.join(tmp, 'user-data')
md = os.path.join(tmp, 'meta-data')
with open(ud, 'w') as f:
    f.write('#cloud-config\n')
    f.write('password: instabox\n')
    f.write('chpasswd: { expire: False }\n')
    f.write('ssh_pwauth: True\n')
    f.write('users:\n')
    f.write('  - name: instabox\n')
    f.write('    sudo: ALL=(ALL) NOPASSWD:ALL\n')
    f.write('    shell: /bin/bash\n')
    f.write('    passwd: "$6$rounds=4096$instabox$8J..." \n')
with open(md, 'w') as f:
    f.write('instance-id: ' + name + '\n')
    f.write('local-hostname: ' + name + '\n')

iso = pycdlib.PyCdlib()
iso.new(interchange_level=3, joliet=3, rock_ridge='1.09', vol_ident='cidata')
iso.add_file(ud, '/USERDATA.;1', rr_name='user-data')
iso.add_file(md, '/METADATA.;1', rr_name='meta-data')
iso.write(out)
iso.close()
print('ok')
